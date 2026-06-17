// Journal panel — view of plugins/main-panel.js. Port of retail
// gmJournalUI (layout 0x21000066, 34 elements, 7 image DIDs).
// Bound to the J key.
//
// Iconic parchment styling — the 7 DIDs form a parchment 9-slice frame:
//   0x0600126F — solid parchment-cream body fill (large).
//   0x06001270 — torn parchment TOP edge with shadow strip.
//   0x06001271 — vertical LEFT edge strip.
//   0x06001272 — vertical RIGHT edge strip.
//   0x06001273 — torn parchment BOTTOM edge with shadow strip.
//   0x060022BA — dark leather outer backdrop.
//   0x06004CCA — gray spacer placeholder (unused in this view).
//
// Per the acpedia "Quest Journal" + "Contracts & Journal Panel" pages,
// Journal entries are quest progress notes the player accumulates as
// they complete missions. Companion tab strip with Contracts.
//
// HUD rec #147 — entries are sourced live from the contract tracker (the
// only quest-shaped data ACE sends; the contract tracker IS the retail quest
// journal). projectContractsToJournalEntries() maps SessionHandle.playerContracts()
// + the DAT ContractTable (window.getContractRecord) into the parchment's
// {title, status, body} rows; the panel falls back to placeholder content
// before login. ~322 contract-quests reach the client — non-contract quest
// flags stay server-side and are not shown.
//
// Layout-port 2026-05-24: wired retail gmJournalUI (LayoutDesc
// 0x21000066, 300×500 active panel + 300×600 chrome wrapper) — sizes
// and positions for the top tab strip, header search/filter row, quest
// list region, right scrollbar slot, footer pagination row, and the
// three bottom action buttons come from the DAT. Text content
// (button labels, sample entries) is hand-tuned (v1 fetch_layout
// serializes geometry only — StateDesc + BaseProperty text content
// is a follow-on, G3 in the layout-port plan).
//
// Note on dimensions: retail's gmJournalUI lives in a 300×600 frame
// (chrome group 0x10000116). Our main-panel body slot is 300×337.
// Layout positions are applied verbatim — content below y=337 lives
// inside an overflow:auto root so footer/buttons remain reachable.
//
// Element-id map (confirmed by journal_panel_layout_dump 2026-05-24):
//   Main group 0x1000055B (300×500, 26 children):
//     0x10000110 — backdrop fill (0,0) 300×500
//     0x10000565 — top-left tab area (0,0) 54×33
//     0x10000566 — bottom-right indicator (235,468) 65×32
//     0x10000567 — top tab 1 / Journal (50,14) 60×18, default_state=1 (active)
//     0x10000568 — top tab 2 / Contracts (126,14) 44×18
//     0x10000569 — top tab 3 / title area (164,14) 120×18
//     0x1000056A — section label A (16,40) 40×18 — "Title:" / filter label
//     0x1000056B — search/title field (50,40) 234×18
//     0x1000056C — section label B (16,66) 50×18 — "Filter:" / status
//     0x1000056D — quest entry list (16,84) 256×330
//     0x1000056E — right scrollbar (272,84) 16×330
//     0x1000056F — bottom-left action button (20,464) 60×32, default_state=1
//     0x10000570 — bottom-middle action button (100,464) 100×32
//     0x10000571 — bottom-right action button (200,464) 60×32, default_state=1
//     Footer row 1 (y=420):
//       0x10000572 — footer label A (16,420) 64×18
//       0x10000573 — footer text (84,420) 150×18
//       0x10000574 — footer right indicator (240,420) 52×18, default_state=1
//     Footer row 2 (y=442) — page indicator / pagination digits:
//       0x10000575 — page label (16,442) 64×18 — "Page:"
//       0x10000576 — pg digit 1 (84,442) 20×18
//       0x10000577 — pg sep (106,442) 10×18
//       0x10000578 — pg digit 2 (120,442) 20×18
//       0x10000579 — pg sep (142,442) 10×18
//       0x1000057A — pg digit 3 (156,442) 20×18
//       0x1000057B — pg sep (178,442) 10×18
//       0x1000057C — pg label (84,442) 120×18 — overlay over digits
//       0x1000057D — pg action indicator (240,442) 40×18, default_state=1
//   Chrome group 0x10000116 (300×600, 5 children) — frame
//     0x10000117 — header strip (0,0) 300×33
//     0x10000118 — left edge (0,33) 22×535
//     0x10000110 — body backdrop (22,33) 257×535
//     0x10000119 — right edge (279,33) 21×535
//     0x1000011A — footer strip (0,568) 300×32
//
// We DON'T wire chrome group elements — main-panel.js owns the panel
// frame chrome (title bar / borders / footer). Wiring the main group's
// content positions is the bulk of the port.

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";

const STYLE_ID = "hb-journal-view-style";

// gmJournalUI — retail layout that drives the journal panel content.
const JOURNAL_LAYOUT_ID = 0x21000066;
const JE = {
  // Main group children (positions relative to the journal root).
  backdrop:        0x10000110,
  topTab1Anchor:   0x10000565,
  bottomRightInd:  0x10000566,
  tabJournal:      0x10000567,
  tabContracts:    0x10000568,
  tabTitle:        0x10000569,
  lblSection:      0x1000056A,
  searchField:     0x1000056B,
  lblFilter:       0x1000056C,
  entryList:       0x1000056D,
  scrollbar:       0x1000056E,
  btnLeft:         0x1000056F,
  btnMiddle:       0x10000570,
  btnRight:        0x10000571,
  footLblA:        0x10000572,
  footText:        0x10000573,
  footRightInd:    0x10000574,
  pageLbl:         0x10000575,
  pgDigit1:        0x10000576,
  pgSep1:          0x10000577,
  pgDigit2:        0x10000578,
  pgSep2:          0x10000579,
  pgDigit3:        0x1000057A,
  pgSep3:          0x1000057B,
  pgLbl:           0x1000057C,
  pgActionInd:     0x1000057D,
};

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-journal-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow-y: auto;
      overflow-x: hidden;
      background: url("./data/ui-sprites/0x060022BA.png") repeat;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    /* Tab strip lives at y=14 per retail gmJournalUI 0x21000066
       (elements 0x10000567/68/69). applyJournalLayout pins these per
       element-id; CSS just provides paint. */
    .hb-journal-tab {
      position: absolute;
      box-sizing: border-box;
      padding: 0 6px;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      border-bottom: none;
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-journal-tab:hover { background: var(--hb-overlay-hover); }
    .hb-journal-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    /* Parchment frame: 9-slice composed from the 5 dedicated parchment
       sprites — fills the quest list region (retail 0x1000056D).
       Applied via applyJournalLayout — the inline left/top/width/height
       lock it to the layout's position. */
    .hb-journal-parchment {
      position: absolute;
      box-sizing: border-box;
      padding: 14px 12px;
      background: url("./data/ui-sprites/0x0600126F.png") repeat;
      color: #2a1a08;            /* dark ink colour on the cream parchment */
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(80, 50, 20, 0.7) rgba(0, 0, 0, 0.3);
    }
    /* Torn-edge sprite assignments swapped per user 2026-05-22:
       0x06001273 sprite has its torn frill on the BOTTOM edge of the
       sprite — anchor it to the parchment's TOP and let it overhang
       upward into the dark backdrop. Mirror for 0x06001270 at bottom. */
    .hb-journal-parchment::before,
    .hb-journal-parchment::after {
      content: "";
      position: absolute;
      left: -4px; right: -4px;
      height: 14px;
      pointer-events: none;
      background-repeat: no-repeat;
      background-size: 100% 100%;
      z-index: 2;
    }
    .hb-journal-parchment::before {
      top: -2px;
      background-image: url("./data/ui-sprites/0x06001273.png");
    }
    .hb-journal-parchment::after {
      bottom: -2px;
      background-image: url("./data/ui-sprites/0x06001270.png");
    }
    /* Vertical L/R edge strips. Inset within the parchment box. */
    .hb-journal-edge-l,
    .hb-journal-edge-r {
      position: absolute;
      top: 0; bottom: 0;
      width: 6px;
      background-repeat: no-repeat;
      background-size: 100% 100%;
      pointer-events: none;
    }
    .hb-journal-edge-l {
      left: 0;
      background-image: url("./data/ui-sprites/0x06001271.png");
    }
    .hb-journal-edge-r {
      right: 0;
      background-image: url("./data/ui-sprites/0x06001272.png");
    }
    /* Scrollbar slot — retail 0x1000056E (272,84) 16×330. Decorative;
       browser-managed scrollbar inside .hb-journal-parchment overlays it. */
    .hb-journal-scrollbar {
      position: absolute;
      box-sizing: border-box;
      border-left: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.4);
      pointer-events: none;
    }
    .hb-journal-content {
      position: relative;
      z-index: 1;
      padding: 0 4px;
    }
    .hb-journal-title {
      font-size: 13px;
      color: #6b3a0a;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid rgba(80, 50, 20, 0.4);
      font-weight: 600;
    }
    .hb-journal-entry {
      margin: 0 0 10px;
      font-size: 11px;
      line-height: 15px;
      color: #2a1a08;
      text-shadow: 0 1px 0 rgba(255, 240, 200, 0.4);
    }
    .hb-journal-entry-h {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-weight: 600;
      color: #4a2810;
      margin-bottom: 2px;
    }
    .hb-journal-entry-status {
      font-style: italic;
      color: #6b3a0a;
      font-size: 9px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .hb-journal-entry-status.complete { color: #2a6020; }
    .hb-journal-entry-status.failed   { color: #802020; }
    .hb-journal-entry-body { color: #3a2210; }
    .hb-journal-empty {
      padding: 16px 8px;
      color: #5a3a18;
      font-style: italic;
      text-align: center;
      font-size: 11px;
    }
    /* Header row fields (retail 0x1000056A/B/C). Section labels + the
       search/title field. */
    .hb-journal-hdr-label {
      position: absolute;
      box-sizing: border-box;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      letter-spacing: 0.04em;
      pointer-events: none;
      display: flex;
      align-items: center;
    }
    .hb-journal-hdr-field {
      position: absolute;
      box-sizing: border-box;
      font-size: 10px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      padding: 0 4px;
      display: flex;
      align-items: center;
    }
    /* Bottom action buttons — retail 0x1000056F/70/71. */
    .hb-journal-btn {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      font-weight: 600;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95);
      background: url("./data/ui-sprites/0x06004CDA.png") center/100% 100% no-repeat;
      border: none;
      cursor: pointer;
      user-select: none;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hb-journal-btn:hover {
      background: url("./data/ui-sprites/0x06004CDB.png") center/100% 100% no-repeat;
      color: var(--hb-text-cream-bright);
    }
    .hb-journal-btn.active {
      background: url("./data/ui-sprites/0x06004CDB.png") center/100% 100% no-repeat;
      color: var(--hb-text-cream-bright);
    }
    /* Footer row 1 (y=420) — status text + indicator. */
    .hb-journal-footer-lbl,
    .hb-journal-footer-text {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      letter-spacing: 0.04em;
      pointer-events: none;
      display: flex;
      align-items: center;
    }
    .hb-journal-footer-lbl { color: var(--hb-text-gold); }
    .hb-journal-footer-ind {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      padding: 0 4px;
      letter-spacing: 0.04em;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* Footer row 2 (y=442) — pagination digits + separators. */
    .hb-journal-pg-lbl {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.9);
      letter-spacing: 0.04em;
      pointer-events: none;
      display: flex;
      align-items: center;
    }
    .hb-journal-pg-digit {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid var(--hb-border-brass-dim);
      display: flex;
      align-items: center;
      justify-content: center;
      font-variant-numeric: tabular-nums;
    }
    .hb-journal-pg-sep {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .hb-journal-pg-text {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      pointer-events: none;
      display: flex;
      align-items: center;
      /* Sits behind / overlapping digits in retail; we hide by default. */
      display: none;
    }
    .hb-journal-pg-action {
      position: absolute;
      box-sizing: border-box;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-gold);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.95);
      background: url("./data/ui-sprites/0x06004CDB.png") center/100% 100% no-repeat;
      cursor: pointer;
      user-select: none;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* Bottom-right corner indicator (retail 0x10000566 — 65×32 at 235,468).
       In retail this is a sealed-wax stamp / parchment seal at the
       bottom-right of the journal page. */
    .hb-journal-seal {
      position: absolute;
      box-sizing: border-box;
      background: url("./data/ui-sprites/0x06004CCA.png") center/100% 100% no-repeat;
      pointer-events: none;
      opacity: 0.6;
    }
  `;
  document.head.appendChild(style);
}

// Placeholder entries until SessionHandle.journal() lands.
const SAMPLE_ENTRIES = [
  {
    title: "Welcome to Dereth",
    status: "active",
    body: "You arrived on the mysterious world of Dereth seeking adventure and fortune. Speak with the Town Crier in Holtburg to learn the ways of this land.",
  },
  {
    title: "The Lugian Threat",
    status: "active",
    body: "A band of Lugian raiders has been spotted southeast of Holtburg. Investigate their camp and report back to the captain of the guard.",
  },
  {
    title: "Beginner's Quest",
    status: "complete",
    body: "Defeat 10 drudges in the Holtburg Training Academy. Reward received.",
  },
];

// ─── HUD rec #147 — live quest journal from the contract tracker ──────
// The contract tracker IS the retail quest journal: ACE only surfaces quest
// state to the client via SendClientContractTracker(Table) (there is no
// QuestUpdate opcode). Mirror contracts-panel.js's wasm access — read the
// live snapshot from SessionHandle.playerContracts(), resolve names/text from
// the DAT-backed ContractTable (window.getContractRecord), and project into
// the {title, status, body} shape the parchment renders. JS-only: every
// wasm surface used here already ships.

function fetchContractsSnapshot() {
  const handle = (typeof window !== "undefined") ? window.__sessionHandle : null;
  if (typeof handle?.playerContracts !== "function") return null;
  try { return handle.playerContracts() ?? null; } catch (_) { return null; }
}

let contractTablePrefetched = false;
let contractTablePrefetchInFlight = null;
async function ensureContractTablePrefetched() {
  if (contractTablePrefetched) return true;
  if (contractTablePrefetchInFlight) return contractTablePrefetchInFlight;
  if (typeof window?.prefetchContractTable !== "function") return false;
  contractTablePrefetchInFlight = (async () => {
    try { await window.prefetchContractTable(); contractTablePrefetched = true; return true; }
    catch (_) { return false; }
    finally { contractTablePrefetchInFlight = null; }
  })();
  return contractTablePrefetchInFlight;
}

function lookupContractRecord(id) {
  if (typeof window?.getContractRecord !== "function") return null;
  try { return window.getContractRecord(id >>> 0) ?? null; } catch (_) { return null; }
}

/**
 * Pure projection: a ContractsSnapshot (from SessionHandle.playerContracts())
 * → journal entries. `lookup(id)` returns the DAT ContractRecord
 * (window.getContractRecord) or null; `nowSec` is the current epoch seconds
 * (active-vs-cooldown). Exported for unit tests; the DOM render consumes
 * `{id, title, status, body}`.
 *
 * ContractStage: 1=New, 2=InProgress, 3=DoneOrPendingRepeat. The DAT
 * `descriptionProgress` is a template with `%d` placeholders we cannot fill
 * client-side (the running count lives server-side in
 * CharacterPropertiesQuestRegistry), so the `%d` are blanked best-effort.
 *
 * @param {{ trackers?: Array<{contractId?:number, stage?:number, timeWhenRepeats?:number}> }|null} snapshot
 * @param {(id:number)=>({name?:string, description?:string, descriptionProgress?:string}|null)} lookup
 * @param {number} nowSec
 * @returns {Array<{id:number, title:string, status:string, body:string, progressText:string}>}
 */
export function projectContractsToJournalEntries(snapshot, lookup, nowSec) {
  if (!snapshot) return [];
  const trackers = snapshot.trackers || [];
  const out = [];
  for (const tr of trackers) {
    const id = (tr.contractId ?? 0) >>> 0;
    const stage = (tr.stage ?? 0) >>> 0;
    const rec = (typeof lookup === "function") ? lookup(id) : null;
    const title = (rec && rec.name) ? rec.name : `Contract ${id}`;
    const description = (rec && rec.description) ? rec.description : "";
    const rawProgress = (rec && rec.descriptionProgress) ? rec.descriptionProgress : "";
    const progressText = rawProgress ? rawProgress.replace(/%d/g, "?").trim() : "";
    let status;
    if (stage >= 3) {
      const repeatAt = Number(tr.timeWhenRepeats || 0);
      status = (repeatAt > nowSec) ? "cooldown" : "complete";
    } else {
      status = "active";
    }
    let body = description;
    if (progressText && (!description || !description.includes(progressText))) {
      body = description ? `${description}  •  ${progressText}` : progressText;
    }
    out.push({ id, title, status, body, progressText });
  }
  return out;
}

// Apply gmJournalUI 0x21000066 layout to the journal plugin's sub-
// elements. Each ref gets explicit left/top/width/height from the
// LayoutDesc. Text content (button labels, tab labels, footer copy)
// stays hand-tuned (v1 fetch_layout serializes geometry only —
// StateDesc + BaseProperty text content is a G3 follow-on).
//
// The journal view mounts via user-initiated showView("journal")
// AFTER wasm is ready, so no retry loop is needed (unlike radar /
// chat-panel which mount during early boot). The cached-layout fast
// path keeps re-opens synchronous.
function applyJournalLayout(refs) {
  const apply = (layout) => {
    if (!layout) return;
    let applied = 0;
    const pairs = [
      [JE.tabJournal,     refs.tabJournalEl],
      [JE.tabContracts,   refs.tabContractsEl],
      [JE.tabTitle,       refs.tabTitleEl],
      [JE.lblSection,     refs.lblSectionEl],
      [JE.searchField,    refs.searchFieldEl],
      [JE.lblFilter,      refs.lblFilterEl],
      [JE.entryList,      refs.parchmentEl],
      [JE.scrollbar,      refs.scrollbarEl],
      [JE.btnLeft,        refs.btnLeftEl],
      [JE.btnMiddle,      refs.btnMiddleEl],
      [JE.btnRight,       refs.btnRightEl],
      [JE.footLblA,       refs.footLblAEl],
      [JE.footText,       refs.footTextEl],
      [JE.footRightInd,   refs.footRightIndEl],
      [JE.pageLbl,        refs.pageLblEl],
      [JE.pgDigit1,       refs.pgDigit1El],
      [JE.pgSep1,         refs.pgSep1El],
      [JE.pgDigit2,       refs.pgDigit2El],
      [JE.pgSep2,         refs.pgSep2El],
      [JE.pgDigit3,       refs.pgDigit3El],
      [JE.pgSep3,         refs.pgSep3El],
      [JE.pgLbl,          refs.pgLblEl],
      [JE.pgActionInd,    refs.pgActionEl],
      [JE.bottomRightInd, refs.sealEl],
    ];
    for (const [id, el] of pairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      applyBox(el, desc);
      applied += 1;
    }
    try {
      window.__diag?.layout?.onJournalApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(JOURNAL_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(JOURNAL_LAYOUT_ID).then(apply).catch(() => {});
}

// Apply a LayoutDesc Element's geometry to a DOM element. Clears
// CSS `right`/`bottom` anchors so explicit left/top wins, and uses
// explicit `transform: none` to defeat any centering translates in the
// underlying CSS rule (radar lesson — clearing transform to "" lets
// the CSS rule's translate re-apply).
function applyBox(el, layoutEl) {
  el.style.right = "";
  el.style.bottom = "";
  el.style.transform = "none";
  if (typeof layoutEl.x === "number") el.style.left = `${layoutEl.x}px`;
  if (typeof layoutEl.y === "number") el.style.top = `${layoutEl.y}px`;
  if (typeof layoutEl.width === "number") el.style.width = `${layoutEl.width}px`;
  if (typeof layoutEl.height === "number") el.style.height = `${layoutEl.height}px`;
}

export const view = {
  name: "Journal",
  nameFor: () => "Quest Journal",
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-journal-root";

    // Tab strip (retail 0x10000567 Journal / 0x10000568 Contracts /
    // 0x10000569 title-area). default_state=1 on 0x10000567 → active.
    const tabJournal = document.createElement("button");
    tabJournal.type = "button";
    tabJournal.className = "hb-journal-tab active";
    tabJournal.dataset.tab = "journal";
    setAcText(tabJournal, "Journal");
    root.appendChild(tabJournal);

    const tabContracts = document.createElement("button");
    tabContracts.type = "button";
    tabContracts.className = "hb-journal-tab";
    tabContracts.dataset.tab = "contracts";
    setAcText(tabContracts, "Contracts");
    tabContracts.addEventListener("click", () => {
      window.__mainPanel?.showView?.("contracts");
    });
    root.appendChild(tabContracts);

    // Third tab slot — retail layout reserves this 120×18 slot at
    // (164,14). Retail uses it for a title/header text field; we leave
    // it as a passive display slot until G3 surfaces its StateDesc text.
    const tabTitle = document.createElement("div");
    tabTitle.className = "hb-journal-tab";
    tabTitle.dataset.tab = "title";
    tabTitle.style.cursor = "default";
    tabTitle.style.pointerEvents = "none";
    setAcText(tabTitle, "Quest Log");
    root.appendChild(tabTitle);

    // Section labels (retail 0x1000056A "Title:" / 0x1000056C "Filter:")
    const lblSection = document.createElement("div");
    lblSection.className = "hb-journal-hdr-label";
    lblSection.dataset.label = "section";
    setAcText(lblSection, "Title:");
    root.appendChild(lblSection);

    // Search/title field (retail 0x1000056B). HUD rec #109 — wire
    // contenteditable + filter-on-input so the parchment shows only
    // matching entries. HUD rec #147 — the same filter now runs over the
    // live `entries` list (contract-derived quests), not SAMPLE_ENTRIES.
    const searchField = document.createElement("div");
    searchField.className = "hb-journal-hdr-field";
    searchField.dataset.field = "search";
    searchField.contentEditable = "true";
    searchField.spellcheck = false;
    searchField.style.outline = "none";
    searchField.style.minHeight = "1em";
    searchField.style.padding = "1px 4px";
    setAcText(searchField, "");
    root.appendChild(searchField);

    const lblFilter = document.createElement("div");
    lblFilter.className = "hb-journal-hdr-label";
    lblFilter.dataset.label = "filter";
    setAcText(lblFilter, "Filter:");
    root.appendChild(lblFilter);

    // Parchment region — retail 0x1000056D (16,84) 256×330. The
    // parchment 9-slice + entry list + scroll lives here.
    const parch = document.createElement("div");
    parch.className = "hb-journal-parchment";
    const edgeL = document.createElement("div");
    edgeL.className = "hb-journal-edge-l";
    parch.appendChild(edgeL);
    const edgeR = document.createElement("div");
    edgeR.className = "hb-journal-edge-r";
    parch.appendChild(edgeR);

    const content = document.createElement("div");
    content.className = "hb-journal-content";

    const title = document.createElement("div");
    title.className = "hb-journal-title";
    const playerName = window.__pluginClient?.player?.stats?.name || "Adventurer";
    // Parchment-ink dark brown — matches the CSS color the canvas
    // replaces. Without the color override the canvas defaults to
    // white, which is invisible on cream parchment.
    setAcText(title, `Journal of ${playerName}`, { color: "#6b3a0a" });
    content.appendChild(title);

    // Entry rendering — extracted so the search field (#109) can
    // re-render with a filtered subset on each keystroke. Static
    // filter state lives in the closure; switching tabs preserves it
    // as long as the panel stays mounted (which it does — main-panel
    // hides via display:none).
    // HUD rec #147 — live entry list. Starts on the placeholder set; swapped
    // to live contract-derived quests by refreshEntries() (post-mount + on
    // every contractsUpdated bus event). `entriesLive` flips once a real
    // snapshot (even an empty one) replaces the placeholder.
    let entries = [...SAMPLE_ENTRIES];
    let entriesLive = false;
    let filterText = "";
    const renderEntriesFiltered = () => {
      // Strip previous entries/notes/empty markers under content;
      // keep the `title` element (first child) intact.
      while (content.children.length > 1) content.removeChild(content.lastChild);
      const q = filterText.trim().toLowerCase();
      const matches = entries.filter((e) => {
        if (!q) return true;
        return (e.title || "").toLowerCase().includes(q)
            || (e.status || "").toLowerCase().includes(q);
      });
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hb-journal-empty";
        setAcText(empty, q
          ? `No entries match “${filterText}”.`
          : "No journal entries yet.", { color: "#5a3a18" });
        content.appendChild(empty);
        return;
      }
      for (const e of matches) {
        const entry = document.createElement("div");
        entry.className = "hb-journal-entry";
        const head = document.createElement("div");
        head.className = "hb-journal-entry-h";
        const t = document.createElement("span");
        setAcText(t, e.title, { color: "#4a2810" });
        head.appendChild(t);
        const s = document.createElement("span");
        s.className = `hb-journal-entry-status ${e.status}`;
        const statusColor = e.status === "complete" ? "#2a6020"
          : e.status === "failed" ? "#802020"
          : "#6b3a0a";
        setAcText(s, e.status, { color: statusColor });
        head.appendChild(s);
        entry.appendChild(head);
        const b = document.createElement("div");
        b.className = "hb-journal-entry-body";
        setAcText(b, e.body, { color: "#3a2210" });
        entry.appendChild(b);
        content.appendChild(entry);
      }
      const note = document.createElement("div");
      note.className = "hb-journal-empty";
      note.style.fontSize = "9px";
      const noteText = q
        ? `—  Showing ${matches.length} of ${entries.length}.  —`
        : entriesLive
          ? `—  ${entries.length} quest${entries.length === 1 ? "" : "s"} from your contract tracker.  —`
          : "—  Placeholder entries — log in to load your quest journal.  —";
      setAcText(note, noteText, { color: "#5a3a18" });
      content.appendChild(note);
    };
    renderEntriesFiltered();

    // Wire search field input — rec #109.
    searchField.addEventListener("input", () => {
      filterText = (searchField.textContent || "").replace(/\n/g, " ");
      renderEntriesFiltered();
    });

    parch.appendChild(content);
    root.appendChild(parch);

    // Scrollbar slot (retail 0x1000056E)
    const scrollbar = document.createElement("div");
    scrollbar.className = "hb-journal-scrollbar";
    root.appendChild(scrollbar);

    // Bottom action buttons (retail 0x1000056F left / 0x10000570 middle
    // / 0x10000571 right). default_state=1 on left + right (active
    // visual state in retail; we render via .hb-journal-btn).
    const btnLeft = document.createElement("button");
    btnLeft.type = "button";
    btnLeft.className = "hb-journal-btn active";
    btnLeft.dataset.btn = "left";
    setAcText(btnLeft, "Prev");
    root.appendChild(btnLeft);

    const btnMiddle = document.createElement("button");
    btnMiddle.type = "button";
    btnMiddle.className = "hb-journal-btn";
    btnMiddle.dataset.btn = "middle";
    setAcText(btnMiddle, "Details");
    root.appendChild(btnMiddle);

    const btnRight = document.createElement("button");
    btnRight.type = "button";
    btnRight.className = "hb-journal-btn active";
    btnRight.dataset.btn = "right";
    setAcText(btnRight, "Next");
    root.appendChild(btnRight);

    // Footer row 1 (y=420) — status text row
    const footLblA = document.createElement("div");
    footLblA.className = "hb-journal-footer-lbl";
    footLblA.dataset.row = "1";
    setAcText(footLblA, "Status:");
    root.appendChild(footLblA);

    const footText = document.createElement("div");
    footText.className = "hb-journal-footer-text";
    footText.dataset.row = "1";
    setAcText(footText, `${entries.length} entries`);
    root.appendChild(footText);

    const footRightInd = document.createElement("div");
    footRightInd.className = "hb-journal-footer-ind";
    footRightInd.dataset.row = "1";
    setAcText(footRightInd, "Active");
    root.appendChild(footRightInd);

    // Footer row 2 (y=442) — pagination digits + separators
    const pageLbl = document.createElement("div");
    pageLbl.className = "hb-journal-pg-lbl";
    setAcText(pageLbl, "Page:");
    root.appendChild(pageLbl);

    const pgDigit1 = document.createElement("div");
    pgDigit1.className = "hb-journal-pg-digit";
    pgDigit1.dataset.digit = "1";
    setAcText(pgDigit1, "1");
    root.appendChild(pgDigit1);

    const pgSep1 = document.createElement("div");
    pgSep1.className = "hb-journal-pg-sep";
    pgSep1.dataset.sep = "1";
    setAcText(pgSep1, "/");
    root.appendChild(pgSep1);

    const pgDigit2 = document.createElement("div");
    pgDigit2.className = "hb-journal-pg-digit";
    pgDigit2.dataset.digit = "2";
    setAcText(pgDigit2, "1");
    root.appendChild(pgDigit2);

    const pgSep2 = document.createElement("div");
    pgSep2.className = "hb-journal-pg-sep";
    pgSep2.dataset.sep = "2";
    setAcText(pgSep2, "·");
    root.appendChild(pgSep2);

    const pgDigit3 = document.createElement("div");
    pgDigit3.className = "hb-journal-pg-digit";
    pgDigit3.dataset.digit = "3";
    setAcText(pgDigit3, String(entries.length));
    root.appendChild(pgDigit3);

    const pgSep3 = document.createElement("div");
    pgSep3.className = "hb-journal-pg-sep";
    pgSep3.dataset.sep = "3";
    setAcText(pgSep3, "");
    root.appendChild(pgSep3);

    const pgLbl = document.createElement("div");
    pgLbl.className = "hb-journal-pg-text";
    pgLbl.dataset.field = "pgtext";
    setAcText(pgLbl, "of");
    root.appendChild(pgLbl);

    const pgAction = document.createElement("button");
    pgAction.type = "button";
    pgAction.className = "hb-journal-pg-action";
    pgAction.dataset.action = "page";
    setAcText(pgAction, "Go");
    root.appendChild(pgAction);

    // Bottom-right seal/stamp (retail 0x10000566)
    const seal = document.createElement("div");
    seal.className = "hb-journal-seal";
    root.appendChild(seal);

    parentEl.appendChild(root);

    // Apply retail layout AFTER elements are in the DOM. journal mounts
    // via user-initiated showView("journal") so wasm is ready by then;
    // the cached-layout fast path keeps re-opens synchronous.
    applyJournalLayout({
      tabJournalEl:   tabJournal,
      tabContractsEl: tabContracts,
      tabTitleEl:     tabTitle,
      lblSectionEl:   lblSection,
      searchFieldEl:  searchField,
      lblFilterEl:    lblFilter,
      parchmentEl:    parch,
      scrollbarEl:    scrollbar,
      btnLeftEl:      btnLeft,
      btnMiddleEl:    btnMiddle,
      btnRightEl:     btnRight,
      footLblAEl:     footLblA,
      footTextEl:     footText,
      footRightIndEl: footRightInd,
      pageLblEl:      pageLbl,
      pgDigit1El:     pgDigit1,
      pgSep1El:       pgSep1,
      pgDigit2El:     pgDigit2,
      pgSep2El:       pgSep2,
      pgDigit3El:     pgDigit3,
      pgSep3El:       pgSep3,
      pgLblEl:        pgLbl,
      pgActionEl:     pgAction,
      sealEl:         seal,
    });

    // HUD rec #147 — swap the placeholder list for live contract-derived
    // quests, then keep it fresh. The contract tracker is the only
    // quest-shaped data ACE sends; getContractRecord supplies names/text.
    const updateCounts = () => {
      setAcText(footText, `${entries.length} entries`);
      setAcText(pgDigit3, String(entries.length));
    };
    const refreshEntries = () => {
      const snap = fetchContractsSnapshot();
      if (snap) {
        entries = projectContractsToJournalEntries(snap, lookupContractRecord, Date.now() / 1000);
        entriesLive = true;
      } else {
        // Not logged in / wasm not ready — keep the placeholder set.
        entries = [...SAMPLE_ENTRIES];
        entriesLive = false;
      }
      renderEntriesFiltered();
      updateCounts();
    };
    refreshEntries();
    // Warm the DAT ContractTable so names/descriptions resolve, then
    // re-render once it lands (first paint shows "Contract <id>" until then).
    ensureContractTablePrefetched().then((ok) => { if (ok) refreshEntries(); });
    // Re-render on every contracts delta (kind=34 → contractsUpdated bus).
    const bus = ctx?.client?.events
      ?? (typeof window !== "undefined" ? window.__pluginClient?.events : null)
      ?? null;
    let offContracts = null;
    if (bus && typeof bus.on === "function") {
      const onContracts = () => refreshEntries();
      bus.on("contractsUpdated", onContracts);
      offContracts = () => { try { bus.off?.("contractsUpdated", onContracts); } catch (_) {} };
    }

    return () => {
      if (offContracts) offContracts();
      root.remove();
    };
  },
};

export const manifest = {
  id: "journal-panel",
  name: "Journal",
  icon: "📜",
  iconHidden: true,
  version: "0.2.0",
  description: "Quest Journal (gmJournalUI 0x21000066, parchment 9-slice)",
};
