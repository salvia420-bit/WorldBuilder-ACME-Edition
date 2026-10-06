// Contracts — main-panel view (F7). Port of retail gmContractsUI (layout
// 0x21000069). HUD overhaul 2026-10-05: rebuilt on the hud_kit vocabulary
// against the real retail element map.
//
// Retail layout (m-69.json, 300×500):
//   ContractNameSortButton "Contract" (8,8) · ContractStatusSortButton
//     "Status" (160,8)  — column captions that sort the list
//   ContractsBox (8,30) 270×298 of ContractEntryTemplate rows (270×20:
//     ContractName 152 + ContractStatus 118) + rope scrollbar
//   Status: / Contact: / Contact Location: / Quest Location: (y=332…392)
//   ContractNotesLabel (8,418) 270×52 — the contract description
//   Timed: (8,468) + ContractTimedText · ContractAbandonButton (232,468)
//
// The previous port mis-read that tree: it treated the ContractEntry
// TEMPLATE (152+118 px) as a "Journal | Contracts" tab strip, the sort
// captions as "Active" / "N / 7" labels, and wired Abandon to the wrong
// element, then shifted everything by -163 px — hence the overlapping
// header / "Select a contract…" / "Redo" text in the before-shot.
//
// Retail behaviour matched (acclient.c):
//   • gmContractsUI::FillProgressString — status text per ContractStage:
//     1 "Available", 2 "In Progress", 3 "Done" / "Available" /
//     "Done (<delta> to Repeat)", ≥4 the DAT description_progress
//     template formatted with (stage − 4) — e.g. "3/5 Drudges Slain".
//   • gmContractsUI::UpdateButtons — Notes = description; Contact = start
//     NPC unless the contract is in progress and has an end NPC; locations
//     via LandDefs::gid_to_lcoord → "%.1f%s, %.1f%s" or "Indoors";
//     Timed = "None" / delta / "Finished".
//   • ListenToElementMessage — the column captions sort by name / status
//     and a second click reverses; Abandon sends Event_AbandonContract for
//     the selected row (we confirm first — a modern liberty).
//   • ClientUISystem::DeltaTimeToString — "1mo 2d 3h 4m 5s".
//
// Wire/time semantics (ACE ContractTracker.cs): TimeWhenDone /
// TimeWhenRepeats are SECONDS REMAINING at send time (QuestManager.
// GetNextSolveTime().TotalSeconds) written as doubles; retail subtracts
// the time since `_time_of_server_update`. The panel stamps each tracker
// when it changes and counts down from there. The protocol crate reads
// those doubles as i64 bit patterns (holtburger-protocol contracts/
// events.rs) — decodeWireSeconds() recovers the double either way.

import {
  ensureSocialStyles, el, makeKitButton, makeSpacer, makeListRow, setRowSelected,
  getHandle, withSession, onBus, confirmAction, onSocialBoot,
} from "./social-panel.js";

const STYLE_ID = "hb-contracts-style";
const SP = "./data/ui-sprites";

export const CONTRACT_STAGE = Object.freeze({
  Available: 1,
  InProgress: 2,
  DoneOrPendingRepeat: 3,
  ProgressCounter: 4,
});

// ─── Pure helpers (exported for tests/contracts_panel.test.cjs) ─────────

/**
 * A contract time field as seconds. ACE writes a double; the protocol
 * crate currently reads it as an i64, so the JS number we receive is that
 * bit pattern (|v| ≥ 2^52 for any positive double ≥ 2^-1022). Reinterpret
 * those; plain second counts pass through. ≤ 0 → 0.
 */
export function decodeWireSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 0;
  if (Math.abs(n) < 1e15) return n > 0 ? n : 0;
  try {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigInt64(0, BigInt.asIntN(64, BigInt(Math.trunc(n))), true);
    const d = dv.getFloat64(0, true);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch (_) {
    return 0;
  }
}

/** ClientUISystem::DeltaTimeToString — "1mo 2d 3h 4m 5s" (zero units dropped, seconds always). */
export function deltaTimeToString(seconds) {
  let s = Math.max(0, Math.trunc(Number(seconds) || 0));
  const mo = Math.floor(s / 2592000); s %= 2592000;
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  const parts = [];
  if (mo) parts.push(`${mo}mo`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/** Retail `sprintf(description_progress, stage - 4)` — fills the first integer conversion. */
export function formatProgressTemplate(tpl, n) {
  let done = false;
  return String(tpl ?? "").replace(/%%|%[-+ 0#]*\d*[diu]/g, (m) => {
    if (m === "%%") return "%";
    if (done) return m;
    done = true;
    return String(Math.trunc(Number(n) || 0));
  });
}

/** gmContractsUI::FillProgressString. */
export function contractStatusText(stage, rec, repeatRemainingSec) {
  const st = (stage >>> 0) || 0;
  switch (st) {
    case CONTRACT_STAGE.Available: return "Available";
    case CONTRACT_STAGE.InProgress: return "In Progress";
    case CONTRACT_STAGE.DoneOrPendingRepeat: {
      const rem = Number(repeatRemainingSec) || 0;
      if (rem > 0) return `Done (${deltaTimeToString(rem)} to Repeat)`;
      return rec?.questflagRepeatTime ? "Available" : "Done";
    }
    default:
      if (st >= CONTRACT_STAGE.ProgressCounter) {
        return rec?.descriptionProgress
          ? formatProgressTemplate(rec.descriptionProgress, st - CONTRACT_STAGE.ProgressCounter)
          : "In Progress";
      }
      return "Unknown";
  }
}

/** ContractTimedText: "None" / remaining / "Finished". */
export function contractTimedText(rec, doneRemainingSec) {
  if (!rec?.questflagTimer) return "None";
  const rem = Number(doneRemainingSec) || 0;
  return rem > 0 ? deltaTimeToString(rem) : "Finished";
}

/**
 * Which NPC the Contact rows name (gmContractsUI::UpdateButtons): the
 * start NPC, unless the contract is under way (stage 2 or a progress
 * counter) AND has an end NPC to turn in to.
 */
export function contractContact(stage, rec) {
  if (!rec) return { name: "", cellId: 0 };
  const st = (stage >>> 0) || 0;
  const start = rec.nameNpcStart || "";
  const end = rec.nameNpcEnd || "";
  const useStart = !end || (st !== CONTRACT_STAGE.InProgress && st < CONTRACT_STAGE.ProgressCounter && !!start);
  return useStart
    ? { name: start, cellId: (rec.locationNpcStart?.cellId >>> 0) || 0 }
    : { name: end, cellId: (rec.locationNpcEnd?.cellId >>> 0) || 0 };
}

/**
 * LandDefs::gid_to_lcoord + the gmContractsUI coordinate maths:
 * lcoord = landblock × 8 + cell column/row; coord = (lcoord − 1024) × 0.1
 * + 0.5. Indoor (dungeon) cells and invalid ids → null ("Indoors").
 */
export function cellToMapCoords(cellId) {
  const id = cellId >>> 0;
  const cell = id & 0xFFFF;
  if (!id || cell < 1 || cell > 0x40) return null;
  const x = ((id >>> 21) & 0x7F8) + ((cell - 1) >> 3);
  const y = 8 * ((id >>> 16) & 0xFF) + ((cell - 1) & 7);
  if (x < 0 || y < 0 || x >= 2040 || y >= 2040) return null;
  return { ew: (x - 1024) * 0.1 + 0.5, ns: (y - 1024) * 0.1 + 0.5 };
}

/**
 * Precise map coordinates from a landblock-local position (journal
 * "Record"): global / 240 − 102, the ACE PositionExtensions.GetMapCoords
 * convention. Indoor cells → null.
 */
export function worldToMapCoords(cellId, localX, localY) {
  const id = cellId >>> 0;
  if (!id || (id & 0xFFFF) >= 0x100) return null;
  const gx = ((id >>> 24) & 0xFF) * 192 + (Number(localX) || 0);
  const gy = ((id >>> 16) & 0xFF) * 192 + (Number(localY) || 0);
  return { ew: gx / 240 - 102, ns: gy / 240 - 102 };
}

/** "%.1f%s, %.1f%s" — north/south first, retail letters (none at exactly 0). */
export function formatMapCoords(c) {
  if (!c) return "Indoors";
  const one = (v, pos, neg) => `${Math.abs(v).toFixed(1)}${v > 0 ? pos : (v < 0 ? neg : "")}`;
  return `${one(c.ns, "N", "S")}, ${one(c.ew, "E", "W")}`;
}

/** wasm `getContractRecord` may hand back a JS Map (serde_json → serde_wasm_bindgen). */
export function normalizeContractRecord(rec) {
  if (!rec) return null;
  const conv = (v) => {
    if (v instanceof Map) {
      const o = {};
      for (const [k, val] of v) o[k] = conv(val);
      return o;
    }
    return v;
  };
  const out = conv(rec);
  return (out && typeof out === "object") ? out : null;
}

/**
 * Build the panel model from a wasm ContractsSnapshotJs (or null).
 * `receivedAtSec(id)` returns when that tracker was last received (epoch
 * seconds; defaults to `nowSec`), `lookup(id)` the DAT contract record.
 */
export function buildContractsViewModel(snapshot, nowSec, { receivedAtSec, lookup } = {}) {
  const now = Number(nowSec) || 0;
  const look = typeof lookup === "function" ? lookup : lookupContractRecord;
  const rows = [];
  for (const t of snapshot?.trackers || []) {
    const id = (t.contractId >>> 0) || 0;
    const stage = (t.stage >>> 0) || 0;
    const rec = normalizeContractRecord(look(id));
    const at = typeof receivedAtSec === "function" ? (receivedAtSec(id) ?? now) : now;
    const elapsed = Math.max(0, now - at);
    const repeatRemaining = Math.max(0, decodeWireSeconds(t.timeWhenRepeats) - elapsed);
    const doneRemaining = Math.max(0, decodeWireSeconds(t.timeWhenDone) - elapsed);
    const contact = contractContact(stage, rec);
    const questCell = (rec?.locationQuestArea?.cellId >>> 0) || 0;
    rows.push({
      id,
      stage,
      name: rec?.name || `Contract ${id}`,
      status: contractStatusText(stage, rec, repeatRemaining),
      contact: contact.name || "None",
      contactLoc: contact.cellId ? formatMapCoords(cellToMapCoords(contact.cellId)) : "None",
      questLoc: questCell ? formatMapCoords(cellToMapCoords(questCell)) : "None",
      timed: contractTimedText(rec, doneRemaining),
      notes: rec?.description || "",
      repeatRemaining,
      doneRemaining,
      complete: stage === CONTRACT_STAGE.DoneOrPendingRepeat,
      ticking: repeatRemaining > 0 || (doneRemaining > 0 && !!rec?.questflagTimer),
    });
  }
  return {
    rows,
    count: rows.length,
    displayContractId: (snapshot?.displayContractId >>> 0) || 0,
  };
}

/** Retail SortContractList: by name or status; a second click reverses. */
export function sortContractRows(rows, criteria = "name", reverse = false) {
  const out = [...rows];
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id - b.id;
  out.sort(criteria === "status"
    ? (a, b) => a.status.localeCompare(b.status) || byName(a, b)
    : byName);
  if (reverse) out.reverse();
  return out;
}

// ─── wasm access (DAT ContractTable 0x0E00001D) ─────────────────────────

function wasmFn(name) {
  if (typeof window === "undefined") return null;
  const f = window.__hbWasm?.[name] ?? window[name];
  return typeof f === "function" ? f : null;
}

let contractTablePrefetched = false;
let contractTablePrefetchInFlight = null;
/** One-shot ContractTable prefetch so getContractRecord is synchronous. */
export async function ensureContractTablePrefetched() {
  if (contractTablePrefetched) return true;
  if (contractTablePrefetchInFlight) return contractTablePrefetchInFlight;
  const prefetch = wasmFn("prefetchContractTable");
  if (!prefetch) return false;
  contractTablePrefetchInFlight = (async () => {
    try { await prefetch(); contractTablePrefetched = true; return true; }
    catch (_) { return false; }
    finally { contractTablePrefetchInFlight = null; }
  })();
  return contractTablePrefetchInFlight;
}

/** DAT contract record (normalised to a plain object) or null. */
export function lookupContractRecord(id) {
  const get = wasmFn("getContractRecord");
  if (!get) return null;
  try { return normalizeContractRecord(get(id >>> 0)); } catch (_) { return null; }
}

export function fetchContractsSnapshot() {
  const handle = getHandle();
  if (typeof handle?.playerContracts !== "function") return null;
  try { return handle.playerContracts() ?? null; } catch (_) { return null; }
}

// Receive-time stamps (retail `_time_of_server_update`). A tracker whose
// stage/time fields change is re-stamped; the bus listener below stamps on
// arrival, mount-time observation covers anything that slipped past it.
const stamps = new Map(); // id → { key, atSec }
export function noteContractTrackers(trackers, nowSec, stampMap = stamps) {
  for (const t of trackers || []) {
    const id = (t.contractId >>> 0) || 0;
    const key = `${t.stage}|${t.timeWhenDone}|${t.timeWhenRepeats}`;
    if (stampMap.get(id)?.key !== key) stampMap.set(id, { key, atSec: nowSec });
  }
  return stampMap;
}
export function contractReceivedAt(id) {
  return stamps.get(id >>> 0)?.atSec;
}
function stampNow() {
  noteContractTrackers(fetchContractsSnapshot()?.trackers, Date.now() / 1000);
}
// Stamp on arrival for the page lifetime (installed at HUD boot, re-bound
// when a reconnect brings a new plugin client).
let stampBus = null;
let stampWaiting = false;
function installStampListener() {
  if (typeof window === "undefined") return;
  const bus = window.__pluginClient?.events;
  if (bus?.on) {
    if (bus !== stampBus) {
      stampBus = bus;
      try { bus.on("contractsUpdated", stampNow); } catch (_) {}
    }
    return;
  }
  if (!stampWaiting && window.__pluginClientReady?.then) {
    stampWaiting = true;
    window.__pluginClientReady.then(() => {
      stampWaiting = false;
      installStampListener();
    }).catch(() => { stampWaiting = false; });
  }
}
onSocialBoot(installStampListener);

// ─── Styles ─────────────────────────────────────────────────────────────

function ensureStyles() {
  ensureSocialStyles();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-con-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; gap: 3px;
      padding: 5px 6px 6px; box-sizing: border-box;
      font-family: var(--hbk-font); font-size: 12px; color: var(--hbk-text);
      background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
      user-select: none;
    }
    .hb-con-sort { flex: 0 0 auto; display: flex; padding: 0 4px; }
    .hb-con-sortbtn {
      background: none; border: 0; padding: 0 2px; margin: 0;
      color: var(--hbk-gold-bright); font: inherit; font-size: 11px;
      letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer;
    }
    .hb-con-sortbtn:hover, .hb-con-sortbtn:focus-visible { color: #fff; outline: none; }
    .hb-con-sortbtn[aria-sort="ascending"]::after { content: " \\25B4"; color: var(--hbk-gold); }
    .hb-con-sortbtn[aria-sort="descending"]::after { content: " \\25BE"; color: var(--hbk-gold); }
    .hb-con-sortbtn.is-status { margin-left: auto; }
    .hb-con-list { flex: 1 1 auto; min-height: 60px; }
    .hb-con-row .hb-soc-row-meta { max-width: 52%; overflow: hidden; text-overflow: ellipsis; }
    .hb-con-row[data-stage="1"] .hb-soc-row-meta { color: var(--hbk-value); }
    .hb-con-row[data-stage="3"] .hb-soc-row-meta { color: var(--hbk-text-faint); }
    .hb-con-row.is-selected .hb-soc-row-meta { color: var(--hbk-gold-bright); }
    .hb-con-details { flex: 0 0 auto; display: grid; grid-template-columns: auto 1fr; column-gap: 8px; row-gap: 1px; padding: 0 4px; }
    .hb-con-details > .k { color: var(--hbk-text-dim); white-space: nowrap; }
    .hb-con-details > .v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-con-notes {
      flex: 0 0 auto; max-height: 52px; min-height: 30px;
      padding: 3px 6px; line-height: 1.3; font-size: 12px; color: var(--hbk-text);
      background: rgba(0, 0, 0, 0.45); border: 1px solid #000;
      user-select: text;
    }
    .hb-con-notes.is-empty { color: var(--hbk-text-faint); font-style: italic; }
    .hb-con-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 0 0 0 4px; }
    .hb-con-foot .k { color: var(--hbk-text-dim); }
    .hb-con-foot .v { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
  document.head.appendChild(style);
}

// ─── View ───────────────────────────────────────────────────────────────

// Retail keeps m_SortCriteria / m_ReverseSort for the session.
let sortCriteria = "name";
let sortReverse = false;

export const view = {
  name: "Contracts",
  nameFor: () => "Contracts",
  mount: (parentEl, ctx) => {
    ensureStyles();
    installStampListener();
    const root = el("div", "hb-con-root");

    const sortBar = el("div", "hb-con-sort");
    const nameSort = el("button", "hb-con-sortbtn", "Contract");
    nameSort.type = "button";
    const statusSort = el("button", "hb-con-sortbtn is-status", "Status");
    statusSort.type = "button";
    sortBar.appendChild(nameSort);
    sortBar.appendChild(statusSort);
    root.appendChild(sortBar);

    const list = el("div", "hbk-scroll hbk-list hb-soc-list hb-con-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Contracts");
    root.appendChild(list);
    root.appendChild(makeSpacer());

    const details = el("div", "hb-con-details");
    const kv = (label) => {
      details.appendChild(el("span", "k", label));
      const v = el("span", "v", "");
      details.appendChild(v);
      return v;
    };
    const vStatus = kv("Status:");
    const vContact = kv("Contact:");
    const vContactLoc = kv("Contact Location:");
    const vQuestLoc = kv("Quest Location:");
    root.appendChild(details);
    const notes = el("div", "hbk-scroll hb-con-notes");
    root.appendChild(notes);
    const foot = el("div", "hb-con-foot");
    foot.appendChild(el("span", "k", "Timed:"));
    const vTimed = el("span", "v", "");
    foot.appendChild(vTimed);
    const abandonBtn = makeKitButton("Abandon", () => {
      const r = vm.rows.find((x) => x.id === selectedId);
      if (!r) return;
      confirmAction({
        title: "Abandon Contract",
        message: `Abandon “${r.name}”? Any progress on it will be lost.`,
        confirmLabel: "Abandon",
        onConfirm: () => withSession("abandonContract", (h) => h.abandonContract(r.id >>> 0)),
      });
    }, { title: "Abandon the selected contract" });
    foot.appendChild(abandonBtn);
    root.appendChild(foot);
    parentEl.appendChild(root);

    let vm = { rows: [], count: 0 };
    let selectedId = (ctx?.contractId >>> 0) || 0;
    const rowEls = new Map(); // id → { row, meta }

    function paintDetails() {
      const r = vm.rows.find((x) => x.id === selectedId);
      if (!r) {
        vStatus.textContent = "";
        vContact.textContent = "";
        vContactLoc.textContent = "";
        vQuestLoc.textContent = "";
        vTimed.textContent = "";
        notes.textContent = vm.rows.length ? "Select a contract to see its details." : "";
        notes.classList.add("is-empty");
        abandonBtn.disabled = true;
        return;
      }
      vStatus.textContent = r.status; vStatus.title = r.status;
      vContact.textContent = r.contact; vContact.title = r.contact;
      vContactLoc.textContent = r.contactLoc;
      vQuestLoc.textContent = r.questLoc;
      vTimed.textContent = r.timed;
      notes.textContent = r.notes || "No notes for this contract.";
      notes.classList.toggle("is-empty", !r.notes);
      abandonBtn.disabled = false;
    }

    function paintSortCaptions() {
      nameSort.setAttribute("aria-sort", sortCriteria === "name" ? (sortReverse ? "descending" : "ascending") : "none");
      statusSort.setAttribute("aria-sort", sortCriteria === "status" ? (sortReverse ? "descending" : "ascending") : "none");
    }

    function compute() {
      const snap = fetchContractsSnapshot();
      const now = Date.now() / 1000;
      noteContractTrackers(snap?.trackers, now);
      const model = buildContractsViewModel(snap, now, { receivedAtSec: contractReceivedAt });
      model.rows = sortContractRows(model.rows, sortCriteria, sortReverse);
      return { snap, model };
    }

    function render() {
      const { snap, model } = compute();
      vm = model;
      paintSortCaptions();
      list.textContent = "";
      rowEls.clear();
      if (!vm.rows.length) {
        // ACE only pushes the tracker table when the player HAS contracts,
        // so a null snapshot while logged in simply means "none".
        list.appendChild(el("div", "hbk-empty", (snap || getHandle())
          ? "You have no contracts. Speak with a quest giver to take one on."
          : "Log in to see your contracts."));
      }
      for (const r of vm.rows) {
        const row = makeListRow(r.name, r.status, { selected: r.id === selectedId });
        row.classList.add("hb-con-row");
        row.dataset.id = String(r.id);
        row.dataset.stage = String(Math.min(r.stage, 4));
        row.title = r.name;
        row.addEventListener("click", () => {
          selectedId = r.id;
          setRowSelected(list, row);
          paintDetails();
        });
        list.appendChild(row);
        rowEls.set(r.id, { row, meta: row.querySelector(".hb-soc-row-meta") });
      }
      if (!vm.rows.some((r) => r.id === selectedId)) selectedId = 0;
      paintDetails();
      if (selectedId) rowEls.get(selectedId)?.row?.scrollIntoView?.({ block: "nearest" });
    }

    // Countdown tick: update status / timed text in place (no row rebuild,
    // so scroll and hover survive).
    function tick() {
      if (!vm.rows.some((r) => r.ticking)) return;
      const { model } = compute();
      const byId = new Map(model.rows.map((r) => [r.id, r]));
      for (const r of vm.rows) {
        const n = byId.get(r.id);
        if (!n) continue;
        if (n.status !== r.status) {
          const ref = rowEls.get(r.id);
          if (ref?.meta) ref.meta.textContent = n.status;
        }
      }
      vm = { ...model, rows: vm.rows.map((r) => byId.get(r.id) || r) };
      paintDetails();
    }

    nameSort.addEventListener("click", () => {
      if (sortCriteria === "name") sortReverse = !sortReverse;
      else { sortCriteria = "name"; sortReverse = false; }
      render();
    });
    statusSort.addEventListener("click", () => {
      if (sortCriteria === "status") sortReverse = !sortReverse;
      else { sortCriteria = "status"; sortReverse = false; }
      render();
    });

    render();
    const off = onBus("contractsUpdated", () => { try { render(); } catch (_) {} });
    const timer = setInterval(() => { try { tick(); } catch (_) {} }, 1000);
    // DAT ContractTable → real names/NPCs/locations once it lands.
    ensureContractTablePrefetched().then((ok) => { if (ok && root.isConnected) render(); });

    return () => {
      off();
      clearInterval(timer);
      root.remove();
    };
  },
};

export const manifest = {
  id: "contracts-panel",
  name: "Contracts",
  icon: "📋",
  iconHidden: true,
  version: "0.4.0",
  description: "Contracts (gmContractsUI 0x21000069): sortable list, retail status/timer text, Abandon",
};
