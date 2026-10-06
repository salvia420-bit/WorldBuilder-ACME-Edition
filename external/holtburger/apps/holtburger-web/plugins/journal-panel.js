// Journal — main-panel view (F6). HUD overhaul 2026-10-05.
//
// Two tabs on one parchment book (retail gmJournalUI 0x21000066 paper:
// BookPaper_Top 0x06001273 300×33, BookPaper_Left 0x06001271, body
// 0x0600126F, BookPaper_Right 0x06001272, BookPaper_Bottom 0x06001270):
//
//   Quests — the quest log (HUD rec #147). ACE only surfaces quest state
//     through the contract tracker (SendClientContractTracker{Table}; no
//     QuestUpdate opcode), so each tracked contract becomes a journal
//     entry with retail's status text (gmContractsUI::FillProgressString,
//     shared with plugins/contracts-panel.js) and its DAT description.
//     Clicking an entry opens it in the Contracts panel.
//
//   Notes — retail's actual gmJournalUI: a paged notebook. Element map
//     (m-66.json, confirmed against gmJournalUI::ListenToElementMessage):
//       JournalPreviousButton 0x10000565 (0,0) 54×33  → GotoPage(cur-1)
//       JournalNextButton     0x10000566 (235,468)    → GotoPage(cur+1)
//       NewPageButton "New"   0x10000567 (50,14)      → NewPage + GotoPage(last)
//       PageLabelEntryBox     0x10000569 · PageTitleEntryBox 0x1000056B
//       NotesEntryBox         0x1000056D (16,84) 256×330
//       FirstPageButton       0x1000056F · LastPageButton 0x10000571
//       PageNumberLabel "~ 1 ~" 0x10000570
//       LocationText "00.0S, 00.0W" 0x10000573 + "Record" 0x10000574
//         → ResetLocation (CPlayerSystem::InqPlayerCoords)
//       Days/Hours/Minutes boxes + "Start" 0x1000057D → ResetTimer /
//         ShowRunningTimer ("Reset"); running text via GetTimerText:
//         "None" / "Ready" / ClientUISystem::DeltaTimeToString.
//     Every navigation saves the page first (SaveThisPage). Retail wrote
//     the pages to a per-character file (CreateJournalPath); the browser
//     keeps them per character in localStorage. Modern liberty: a page
//     left completely blank is dropped when you page away from it, so a
//     stray "New" does not leave holes (retail's DeletePage exists but has
//     no button).
//
// The old port mapped this layout's ids onto invented "tabs / filter /
// pagination digits" and stacked a red "Go" button over the heading (the
// before-shot); it also shipped fake placeholder quests pre-login.

import {
  ensureSocialStyles, el, makeKitButton, getHandle, onBus, uid,
} from "./social-panel.js";
import {
  contractStatusText, decodeWireSeconds, deltaTimeToString, formatProgressTemplate,
  worldToMapCoords, formatMapCoords, ensureContractTablePrefetched, lookupContractRecord,
  fetchContractsSnapshot, noteContractTrackers, contractReceivedAt, CONTRACT_STAGE,
} from "./contracts-panel.js";

const STYLE_ID = "hb-journal-style";
const TAB_LS_KEY = "hb.journal.tab.v1";
const PAGES_LS_PREFIX = "hb.journal.pages.v1.";
const SP = "./data/ui-sprites";

// ─── Pure helpers (exported for test_journal_panel.mjs) ─────────────────

/**
 * Contract tracker snapshot → quest-journal entries. `lookup(id)` returns
 * the DAT ContractRecord (or null); `nowSec` is epoch seconds and
 * `receivedAtSec(id)` when each tracker arrived (defaults to now — the
 * wire times are seconds REMAINING, see contracts-panel.js).
 *
 * status: "active" (stages 1, 2, ≥4) · "complete" · "cooldown" (done,
 * waiting to repeat). statusText is retail's FillProgressString text.
 *
 * @returns {Array<{id:number, title:string, status:string, statusText:string, body:string, progressText:string}>}
 */
export function projectContractsToJournalEntries(snapshot, lookup, nowSec, { receivedAtSec } = {}) {
  if (!snapshot) return [];
  const out = [];
  for (const tr of snapshot.trackers || []) {
    const id = (tr.contractId ?? 0) >>> 0;
    const stage = (tr.stage ?? 0) >>> 0;
    const rec = (typeof lookup === "function") ? lookup(id) : null;
    const title = rec?.name || `Contract ${id}`;
    const description = rec?.description || "";
    const at = typeof receivedAtSec === "function" ? (receivedAtSec(id) ?? nowSec) : nowSec;
    const repeatRemaining = Math.max(0, decodeWireSeconds(tr.timeWhenRepeats) - Math.max(0, nowSec - at));
    // Retail only fills description_progress for progress-counter stages
    // (stage − 4 completions); stage 2 reads "In Progress".
    const progressText = (stage >= CONTRACT_STAGE.ProgressCounter && rec?.descriptionProgress)
      ? formatProgressTemplate(rec.descriptionProgress, stage - CONTRACT_STAGE.ProgressCounter).trim()
      : "";
    let status;
    if (stage === CONTRACT_STAGE.DoneOrPendingRepeat) status = repeatRemaining > 0 ? "cooldown" : "complete";
    else status = "active";
    let body = description;
    if (progressText && !description.includes(progressText)) {
      body = description ? `${description}  •  ${progressText}` : progressText;
    }
    out.push({ id, title, status, statusText: contractStatusText(stage, rec, repeatRemaining), body, progressText });
  }
  return out;
}

/** Milliseconds for the Days / Hours / Minutes boxes (gmJournalUI::ResetTimer). */
export function timerDurationMs(d, h, m) {
  const n = (v) => Math.max(0, Math.trunc(Number(v) || 0));
  return ((n(d) * 24 + n(h)) * 60 + n(m)) * 60000;
}

/** GetTimerText: not running → "None"; elapsed → "Ready"; else the delta. */
export function journalTimerText(endsAtMs, nowMs) {
  const end = Number(endsAtMs) || 0;
  if (end <= 0) return "None";
  const rem = Math.floor((end - (Number(nowMs) || 0)) / 1000);
  return rem <= 0 ? "Ready" : deltaTimeToString(rem);
}

function blankPage() {
  return { label: "", title: "", notes: "", loc: null, timer: { d: "", h: "", m: "", endsAt: 0 } };
}

/** True when a page carries nothing worth keeping. */
export function isBlankJournalPage(p) {
  if (!p) return true;
  return !p.label && !p.title && !p.notes && !p.loc && !(p.timer?.endsAt > 0);
}

/** Coerce persisted JSON into a valid page array (always ≥ 1 page). */
export function normalizeJournalPages(raw) {
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p !== "object") continue;
    const page = blankPage();
    page.label = typeof p.label === "string" ? p.label.slice(0, 40) : "";
    page.title = typeof p.title === "string" ? p.title.slice(0, 80) : "";
    page.notes = typeof p.notes === "string" ? p.notes.slice(0, 4000) : "";
    if (p.loc && Number.isFinite(p.loc.ns) && Number.isFinite(p.loc.ew)) page.loc = { ns: p.loc.ns, ew: p.loc.ew };
    else if (p.loc === "indoors") page.loc = "indoors";
    if (p.timer && typeof p.timer === "object") {
      page.timer.d = String(p.timer.d ?? "").slice(0, 3);
      page.timer.h = String(p.timer.h ?? "").slice(0, 3);
      page.timer.m = String(p.timer.m ?? "").slice(0, 3);
      page.timer.endsAt = Number(p.timer.endsAt) > 0 ? Number(p.timer.endsAt) : 0;
    }
    out.push(page);
  }
  if (!out.length) out.push(blankPage());
  return out;
}

// ─── Storage ────────────────────────────────────────────────────────────

function characterName() {
  try {
    const n = window.__pluginClient?.player?.stats?.name;
    if (n) return String(n);
  } catch (_) {}
  try {
    const n = getHandle()?.playerStats?.()?.name;
    if (n) return String(n);
  } catch (_) {}
  return "";
}
function pagesKey() { return PAGES_LS_PREFIX + (characterName() || "_"); }
function loadPages() {
  try { return normalizeJournalPages(JSON.parse(localStorage.getItem(pagesKey()) || "[]")); }
  catch (_) { return normalizeJournalPages([]); }
}
function savePages(pages) {
  try { localStorage.setItem(pagesKey(), JSON.stringify(pages)); } catch (_) {}
}

// ─── Styles ─────────────────────────────────────────────────────────────

function ensureStyles() {
  ensureSocialStyles();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-jrnl-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      font-family: var(--hbk-font); font-size: 12px; color: var(--hbk-text);
      background: url("${SP}/0x060022BA.png") center / cover, var(--hbk-ink, #0b0c10);
      --jr-ink: #2a1a08; --jr-ink-soft: #5a3a18; --jr-accent: #6b3a0a; --jr-green: #2a6020;
    }
    .hb-jrnl-root > .hbk-tabs { flex: 0 0 auto; }
    .hb-jrnl-root [hidden] { display: none !important; }
    .hb-jrnl-root > .hbk-tabs > .hbk-tab { text-transform: none; letter-spacing: 0.02em; font-size: 12px; }
    /* The parchment book: retail BookPaper_* 9-slice. */
    .hb-jrnl-book {
      position: relative; flex: 1 1 auto; min-height: 0;
      color: var(--jr-ink);
      background:
        url("${SP}/0x06001273.png") left top / 100% 33px no-repeat,
        url("${SP}/0x06001270.png") left bottom / 100% 32px no-repeat,
        url("${SP}/0x06001271.png") left 0 top 33px / 22px calc(100% - 65px) no-repeat,
        url("${SP}/0x06001272.png") right 0 top 33px / 21px calc(100% - 65px) no-repeat,
        url("${SP}/0x0600126F.png") center / 265px 100px repeat;
      user-select: none;
    }
    .hb-jrnl-sheet {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; gap: 4px;
      padding: 26px 22px 24px 22px; box-sizing: border-box;
    }
    .hb-jrnl-heading {
      flex: 0 0 auto; text-align: center;
      font-size: 14px; font-weight: 600; letter-spacing: 0.03em; color: var(--jr-accent);
      border-bottom: 1px solid rgba(80, 50, 20, 0.35); padding-bottom: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hb-jrnl-input, .hb-jrnl-text {
      box-sizing: border-box; min-width: 0;
      font-family: var(--hbk-font); font-size: 12px; color: var(--jr-ink);
      background: rgba(255, 246, 220, 0.35);
      border: 1px solid rgba(90, 58, 24, 0.45);
      border-radius: 1px; outline: none;
      user-select: text;
    }
    .hb-jrnl-input { height: 20px; padding: 1px 5px; }
    .hb-jrnl-input:focus, .hb-jrnl-text:focus { border-color: var(--jr-accent); background: rgba(255, 248, 228, 0.55); }
    .hb-jrnl-input::placeholder, .hb-jrnl-text::placeholder { color: rgba(90, 58, 24, 0.6); font-style: italic; }
    .hb-jrnl-list {
      flex: 1 1 auto; min-height: 0;
      scrollbar-color: rgba(90, 58, 24, 0.7) transparent;
    }
    .hb-jrnl-entry {
      padding: 4px 4px 5px; border-bottom: 1px solid rgba(80, 50, 20, 0.22);
      cursor: pointer;
    }
    .hb-jrnl-entry:hover, .hb-jrnl-entry:focus-visible { background: rgba(120, 80, 30, 0.12); outline: none; }
    .hb-jrnl-entry-h { display: flex; align-items: baseline; gap: 8px; }
    .hb-jrnl-entry-title { flex: 1 1 auto; min-width: 0; font-weight: 600; color: #4a2810; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-jrnl-entry-status { flex: 0 0 auto; font-style: italic; font-size: 11px; color: var(--jr-accent); max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-jrnl-entry[data-status="complete"] .hb-jrnl-entry-status { color: var(--jr-green); }
    .hb-jrnl-entry[data-status="cooldown"] .hb-jrnl-entry-status { color: var(--jr-ink-soft); }
    .hb-jrnl-entry-body { margin-top: 1px; font-size: 12px; line-height: 1.3; color: #3a2210; }
    .hb-jrnl-empty { padding: 18px 8px; text-align: center; font-style: italic; color: var(--jr-ink-soft); line-height: 1.4; }
    .hb-jrnl-foot { flex: 0 0 auto; text-align: center; font-size: 11px; font-style: italic; color: var(--jr-ink-soft); }

    /* Notes (retail notebook). */
    .hb-jrnl-notes { padding: 10px 22px 10px 22px; gap: 3px; }
    .hb-jrnl-row { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; min-height: 20px; }
    .hb-jrnl-row > label, .hb-jrnl-k { color: var(--jr-accent); font-weight: 600; white-space: nowrap; }
    .hb-jrnl-row > .hb-jrnl-input { flex: 1 1 auto; }
    .hb-jrnl-row.is-top { padding-left: 34px; }
    .hb-jrnl-text { flex: 1 1 auto; min-height: 40px; resize: none; padding: 3px 5px; line-height: 1.3; }
    .hb-jrnl-v { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .hb-jrnl-num { width: 30px; flex: 0 0 30px !important; text-align: center; padding: 1px 2px !important; }
    .hb-jrnl-unit { color: var(--jr-ink-soft); }
    .hb-jrnl-pager { justify-content: center; padding-right: 54px; padding-left: 0; gap: 8px; }
    .hb-jrnl-pageno { min-width: 52px; text-align: center; color: var(--jr-accent); font-weight: 600; font-variant-numeric: tabular-nums; }
    .hb-jrnl-sheet .hbk-btn-small { min-width: 44px; min-height: 18px; font-size: 11px; }
    /* Retail page-curl arrows (prev 0x06001269/6A/6B, next 0x06001266/67/68). */
    .hb-jrnl-prev, .hb-jrnl-next {
      position: absolute; z-index: 2; padding: 0; border: 0; cursor: pointer;
      background: center / 100% 100% no-repeat; image-rendering: pixelated;
    }
    .hb-jrnl-prev { left: 0; top: 0; width: 54px; height: 33px; background-image: url("${SP}/0x06001269.png"); }
    .hb-jrnl-prev:hover:not(:disabled) { background-image: url("${SP}/0x0600126A.png"); }
    .hb-jrnl-prev:disabled { background-image: url("${SP}/0x0600126B.png"); cursor: default; }
    .hb-jrnl-next { right: 0; bottom: 0; width: 65px; height: 32px; background-image: url("${SP}/0x06001266.png"); }
    .hb-jrnl-next:hover:not(:disabled) { background-image: url("${SP}/0x06001267.png"); }
    .hb-jrnl-next:disabled { background-image: url("${SP}/0x06001268.png"); cursor: default; }
    .hb-jrnl-prev:focus-visible, .hb-jrnl-next:focus-visible { outline: 1px solid var(--jr-accent); }
  `;
  document.head.appendChild(style);
}

// ─── Quests tab ─────────────────────────────────────────────────────────

function mountQuestsTab(book) {
  const sheet = el("div", "hb-jrnl-sheet");
  const who = characterName();
  sheet.appendChild(el("div", "hb-jrnl-heading", who ? `Journal of ${who}` : "Quest Journal"));
  const search = document.createElement("input");
  search.type = "text";
  search.className = "hb-jrnl-input";
  search.placeholder = "Search quests…";
  search.setAttribute("aria-label", "Search quests");
  sheet.appendChild(search);
  const list = el("div", "hbk-scroll hb-jrnl-list");
  list.setAttribute("role", "list");
  sheet.appendChild(list);
  const foot = el("div", "hb-jrnl-foot");
  sheet.appendChild(foot);
  book.appendChild(sheet);

  let entries = [];
  let live = false;
  let filter = "";

  function renderList() {
    list.textContent = "";
    const q = filter.trim().toLowerCase();
    const shown = entries.filter((e) => !q
      || e.title.toLowerCase().includes(q)
      || e.statusText.toLowerCase().includes(q)
      || e.body.toLowerCase().includes(q));
    if (!shown.length) {
      list.appendChild(el("div", "hb-jrnl-empty", !live
        ? "Log in to read your quest journal."
        : q ? `No quests match “${filter.trim()}”.`
          : "Your journal has no quests yet. Accept a contract from a quest giver to begin."));
    }
    for (const e of shown) {
      const item = el("div", "hb-jrnl-entry");
      item.setAttribute("role", "listitem");
      item.tabIndex = 0;
      item.dataset.status = e.status;
      item.title = "Open in the Contracts panel";
      const h = el("div", "hb-jrnl-entry-h");
      h.appendChild(el("span", "hb-jrnl-entry-title", e.title));
      h.appendChild(el("span", "hb-jrnl-entry-status", e.statusText));
      item.appendChild(h);
      if (e.body) item.appendChild(el("div", "hb-jrnl-entry-body", e.body));
      const open = () => window.__mainPanel?.showView?.("contracts", { contractId: e.id });
      item.addEventListener("click", open);
      item.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
      list.appendChild(item);
    }
    foot.textContent = live && entries.length
      ? (q ? `Showing ${shown.length} of ${entries.length} quests` : `${entries.length} quest${entries.length === 1 ? "" : "s"} in your contract tracker`)
      : "";
  }

  function refresh() {
    const snap = fetchContractsSnapshot();
    live = !!getHandle();
    const now = Date.now() / 1000;
    if (snap) noteContractTrackers(snap.trackers, now);
    entries = projectContractsToJournalEntries(snap, lookupContractRecord, now, { receivedAtSec: contractReceivedAt });
    renderList();
  }

  search.addEventListener("input", () => { filter = search.value; renderList(); });
  refresh();
  ensureContractTablePrefetched().then((ok) => { if (ok && sheet.isConnected) refresh(); });
  const off = onBus("contractsUpdated", () => { try { refresh(); } catch (_) {} });
  return () => { off(); sheet.remove(); };
}

// ─── Notes tab (retail gmJournalUI notebook) ────────────────────────────

function mountNotesTab(book) {
  const pages = loadPages();
  let cur = 0; // index into pages
  let saveTimer = 0;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePages(pages), 250);
  };

  const prevBtn = el("button", "hb-jrnl-prev");
  prevBtn.type = "button";
  prevBtn.title = "Previous page";
  prevBtn.setAttribute("aria-label", "Previous page");
  const nextBtn = el("button", "hb-jrnl-next");
  nextBtn.type = "button";
  nextBtn.title = "Next page";
  nextBtn.setAttribute("aria-label", "Next page");

  const sheet = el("div", "hb-jrnl-sheet hb-jrnl-notes");
  // New + Label (retail NewPageButton (50,14) / PageLabelEntryBox (164,14)).
  const top = el("div", "hb-jrnl-row is-top");
  const newBtn = makeKitButton("New", () => { goTo(pages.length, { create: true }); }, { cls: "hbk-btn-small hbk-brown", title: "Start a new page" });
  const labelLbl = el("label", null, "Label:");
  const labelIn = document.createElement("input");
  labelIn.type = "text";
  labelIn.className = "hb-jrnl-input";
  labelIn.maxLength = 40;
  labelLbl.htmlFor = labelIn.id = uid("hb-jrnl-label");
  top.appendChild(newBtn);
  top.appendChild(labelLbl);
  top.appendChild(labelIn);
  sheet.appendChild(top);
  // Title.
  const titleRow = el("div", "hb-jrnl-row");
  const titleLbl = el("label", null, "Title:");
  const titleIn = document.createElement("input");
  titleIn.type = "text";
  titleIn.className = "hb-jrnl-input";
  titleIn.maxLength = 80;
  titleLbl.htmlFor = titleIn.id = uid("hb-jrnl-title");
  titleRow.appendChild(titleLbl);
  titleRow.appendChild(titleIn);
  sheet.appendChild(titleRow);
  // Notes.
  const notesLbl = el("label", "hb-jrnl-k", "Notes:");
  const notesIn = document.createElement("textarea");
  notesIn.className = "hb-jrnl-text hbk-scroll";
  notesIn.maxLength = 4000;
  notesIn.spellcheck = false;
  notesLbl.htmlFor = notesIn.id = uid("hb-jrnl-notes");
  sheet.appendChild(notesLbl);
  sheet.appendChild(notesIn);
  // Location + Record.
  const locRow = el("div", "hb-jrnl-row");
  locRow.appendChild(el("span", "hb-jrnl-k", "Location:"));
  const locText = el("span", "hb-jrnl-v", "None");
  locRow.appendChild(locText);
  const recordBtn = makeKitButton("Record", () => {
    // gmJournalUI::ResetLocation → CPlayerSystem::InqPlayerCoords.
    let pose = null;
    try { pose = getHandle()?.getLocalPlayerPose?.() ?? null; } catch (_) {}
    if (!pose) return;
    const c = worldToMapCoords(pose.landblockId, pose.x, pose.y);
    pages[cur].loc = c ? { ns: Math.round(c.ns * 10) / 10, ew: Math.round(c.ew * 10) / 10 } : "indoors";
    paintLocation();
    persist();
  }, { cls: "hbk-btn-small hbk-brown", title: "Record your current coordinates" });
  locRow.appendChild(recordBtn);
  sheet.appendChild(locRow);
  // Timer.
  const timerRow = el("div", "hb-jrnl-row");
  timerRow.appendChild(el("span", "hb-jrnl-k", "Timer:"));
  const mkNum = (aria) => {
    const n = document.createElement("input");
    n.type = "text";
    n.inputMode = "numeric";
    n.maxLength = 3;
    n.className = "hb-jrnl-input hb-jrnl-num";
    n.setAttribute("aria-label", aria);
    return n;
  };
  const dIn = mkNum("Days");
  const hIn = mkNum("Hours");
  const mIn = mkNum("Minutes");
  const editBox = el("span", "hb-jrnl-row");
  editBox.style.flex = "1 1 auto";
  editBox.append(dIn, el("span", "hb-jrnl-unit", "d"), hIn, el("span", "hb-jrnl-unit", "h"), mIn, el("span", "hb-jrnl-unit", "m"));
  const runText = el("span", "hb-jrnl-v");
  timerRow.appendChild(editBox);
  timerRow.appendChild(runText);
  const timerBtn = makeKitButton("Start", () => {
    const t = pages[cur].timer;
    if (t.endsAt > 0) {
      t.endsAt = 0; // running → ShowEditableTimer
    } else {
      const ms = timerDurationMs(dIn.value, hIn.value, mIn.value);
      if (ms <= 0) { dIn.value = hIn.value = mIn.value = ""; t.d = t.h = t.m = ""; paintTimer(); persist(); return; }
      t.d = dIn.value; t.h = hIn.value; t.m = mIn.value;
      t.endsAt = Date.now() + ms; // ResetTimer → ShowRunningTimer
    }
    paintTimer();
    persist();
  }, { cls: "hbk-btn-small hbk-brown" });
  timerRow.appendChild(timerBtn);
  sheet.appendChild(timerRow);
  // First ~ n ~ Last.
  const pager = el("div", "hb-jrnl-row hb-jrnl-pager");
  const firstBtn = makeKitButton("First", () => goTo(0), { cls: "hbk-btn-small hbk-brown" });
  const pageNo = el("span", "hb-jrnl-pageno");
  const lastBtn = makeKitButton("Last", () => goTo(pages.length - 1), { cls: "hbk-btn-small hbk-brown" });
  pager.append(firstBtn, pageNo, lastBtn);
  sheet.appendChild(pager);

  book.appendChild(sheet);
  book.appendChild(prevBtn);
  book.appendChild(nextBtn);

  function paintLocation() {
    const loc = pages[cur].loc;
    locText.textContent = !loc ? "None" : (loc === "indoors" ? "Indoors" : formatMapCoords(loc));
  }
  function paintTimer() {
    const t = pages[cur].timer;
    const running = t.endsAt > 0;
    editBox.hidden = running;
    runText.hidden = !running;
    if (running) runText.textContent = journalTimerText(t.endsAt, Date.now());
    else { dIn.value = t.d; hIn.value = t.h; mIn.value = t.m; }
    timerBtn.textContent = running ? "Reset" : "Start";
    timerBtn.title = running ? "Stop the timer" : "Start counting down";
  }
  function paint() {
    const p = pages[cur];
    labelIn.value = p.label;
    titleIn.value = p.title;
    notesIn.value = p.notes;
    paintLocation();
    paintTimer();
    pageNo.textContent = `~ ${cur + 1} ~`;
    prevBtn.disabled = cur <= 0;
    nextBtn.disabled = cur >= pages.length - 1;
    firstBtn.disabled = cur <= 0;
    lastBtn.disabled = cur >= pages.length - 1;
  }
  // SaveThisPage then GotoPage. A blank page you leave is torn out.
  function goTo(index, { create = false } = {}) {
    if (pages.length > 1 && isBlankJournalPage(pages[cur]) && index !== cur) {
      pages.splice(cur, 1);
      if (index > cur) index -= 1;
    }
    if (create) {
      pages.push(blankPage());
      index = pages.length - 1;
    }
    cur = Math.max(0, Math.min(pages.length - 1, index));
    paint();
    persist();
  }

  labelIn.addEventListener("input", () => { pages[cur].label = labelIn.value; persist(); });
  titleIn.addEventListener("input", () => { pages[cur].title = titleIn.value; persist(); });
  notesIn.addEventListener("input", () => { pages[cur].notes = notesIn.value; persist(); });
  for (const [inp, k] of [[dIn, "d"], [hIn, "h"], [mIn, "m"]]) {
    inp.addEventListener("input", () => {
      inp.value = inp.value.replace(/[^0-9]/g, "");
      pages[cur].timer[k] = inp.value;
      persist();
    });
  }
  prevBtn.addEventListener("click", () => { if (!prevBtn.disabled) goTo(cur - 1); });
  nextBtn.addEventListener("click", () => { if (!nextBtn.disabled) goTo(cur + 1); });

  paint();
  const tick = setInterval(() => {
    if (pages[cur]?.timer?.endsAt > 0) runText.textContent = journalTimerText(pages[cur].timer.endsAt, Date.now());
  }, 1000);

  return () => {
    clearInterval(tick);
    clearTimeout(saveTimer);
    savePages(pages);
    sheet.remove();
    prevBtn.remove();
    nextBtn.remove();
  };
}

// ─── View ───────────────────────────────────────────────────────────────

const TABS = [
  { id: "quests", label: "Quests", mount: mountQuestsTab },
  { id: "notes", label: "Notes", mount: mountNotesTab },
];

export const view = {
  name: "Journal",
  nameFor: () => "Journal",
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = el("div", "hb-jrnl-root");
    const tabs = el("div", "hbk-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Journal");
    const book = el("div", "hb-jrnl-book");
    book.setAttribute("role", "tabpanel");
    root.appendChild(tabs);
    root.appendChild(book);
    parentEl.appendChild(root);

    let cleanup = null;
    const btns = new Map();
    function show(id) {
      if (cleanup) { try { cleanup(); } catch (_) {} }
      cleanup = null;
      book.textContent = "";
      for (const [tid, b] of btns) b.setAttribute("aria-selected", tid === id ? "true" : "false");
      try { localStorage.setItem(TAB_LS_KEY, id); } catch (_) {}
      const t = TABS.find((x) => x.id === id) || TABS[0];
      cleanup = t.mount(book);
    }
    for (const t of TABS) {
      const b = el("button", "hbk-tab", t.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => show(t.id));
      btns.set(t.id, b);
      tabs.appendChild(b);
    }
    let first = ctx?.tab;
    if (!TABS.some((t) => t.id === first)) {
      try { first = localStorage.getItem(TAB_LS_KEY); } catch (_) { first = null; }
    }
    show(TABS.some((t) => t.id === first) ? first : "quests");

    return () => {
      if (cleanup) { try { cleanup(); } catch (_) {} }
      root.remove();
    };
  },
};

export const manifest = {
  id: "journal-panel",
  name: "Journal",
  icon: "📜",
  iconHidden: true,
  version: "0.3.0",
  description: "Journal (gmJournalUI 0x21000066 parchment): quest log + retail paged notebook",
};
