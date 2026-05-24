// Contracts panel — view of plugins/main-panel.js. Port of retail
// gmContractsUI (layout 0x21000069, 20 elements, 3 image DIDs).
// Bound to the K key (J is Journal, sibling tab here).
//
// Per the acpedia "Contracts & Journal Panel" page, Contracts are
// repeatable quest assignments accepted from contract NPCs that
// reset on a timer. Player can have N active contracts (typically
// 7 in retail), each with completion status + cooldown.
//
// DAT sprites (already extracted under data/ui-sprites/):
//   0x06001AAF — dark mottled background panel (shared with allegiance).
//   0x06004CC2 — gray placeholder spacer.
//   0x06004CCA — gray placeholder spacer (alt).
//
// Contract data not yet exposed by SessionHandle — view shows
// placeholder rows with progress + cooldown columns.

import { setAcText } from "../ui/ac_font.js";

const STYLE_ID = "hb-contracts-view-style";

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
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: url("./data/ui-sprites/0x06001AAF.png") repeat;
    }
    .hb-contracts-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 1px;
      padding: 4px 4px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-contracts-tab {
      padding: 3px 10px;
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      border-bottom: none;
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .hb-contracts-tab:hover { background: var(--hb-overlay-hover); }
    .hb-contracts-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    .hb-contracts-meta {
      flex: 0 0 auto;
      padding: 4px 8px;
      display: flex;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
    }
    .hb-contracts-meta .label { color: var(--hb-text-cream); }
    .hb-contracts-meta .value { color: var(--hb-text-gold); font-variant-numeric: tabular-nums; }
    .hb-contracts-list {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-contracts-list-h {
      display: grid;
      grid-template-columns: 1fr 80px 80px;
      gap: 4px;
      padding: 3px 6px;
      font-size: 9px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.35);
    }
    .hb-contracts-row {
      display: grid;
      grid-template-columns: 1fr 80px 80px;
      gap: 4px;
      padding: 3px 6px;
      font-size: 10px;
      line-height: 14px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
      align-items: center;
    }
    .hb-contracts-row:hover { background: var(--hb-overlay-hover); }
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
    .hb-contracts-detail {
      flex: 0 0 auto;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.45);
      border-top: 1px solid var(--hb-border-brass-dim);
      max-height: 120px;
      overflow-y: auto;
    }
    .hb-contracts-detail-title {
      font-size: 11px;
      color: var(--hb-text-gold);
      margin-bottom: 4px;
    }
    .hb-contracts-detail-body {
      font-size: 10px;
      line-height: 14px;
      color: var(--hb-text-cream);
    }
    .hb-contracts-actions {
      flex: 0 0 auto;
      padding: 6px 8px;
      display: flex;
      gap: 6px;
      background: rgba(0, 0, 0, 0.35);
      border-top: 1px solid var(--hb-border-brass-dim);
    }
    .hb-contracts-btn {
      flex: 1 1 auto;
      padding: 4px 8px;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      user-select: none;
    }
    .hb-contracts-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
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
    progress: "0 / 5",
    cooldown: "—",
    complete: false,
    desc: "Speak with Talid in Wai Jhou; he requires Pyreal nuggets for the colony.",
  },
  {
    id: 101,
    name: "Drudge Hunting",
    progress: "10 / 10",
    cooldown: "00:24:11",
    complete: true,
    desc: "Slay 10 drudges in the Holtburg Outskirts. Reward: 2000 XP. Cooldown: 30m.",
  },
  {
    id: 102,
    name: "Daily Rare Pickup",
    progress: "—",
    cooldown: "ready",
    complete: false,
    desc: "Pick up a daily rare from the rotating quest NPC.",
  },
];

export const view = {
  name: "Contracts",
  nameFor: () => "Contracts",
  mount: (parentEl, _ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-contracts-root";

    // Sibling tab strip with Journal.
    const tabs = document.createElement("div");
    tabs.className = "hb-contracts-tabs";
    for (const t of [
      { id: "journal",   label: "Journal",   swap: "journal" },
      { id: "contracts", label: "Contracts", current: true },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-contracts-tab" + (t.current ? " active" : "");
      setAcText(btn, t.label);
      if (t.swap) btn.addEventListener("click", () => window.__mainPanel?.showView?.(t.swap));
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    // Meta row: contract count / max
    const meta = document.createElement("div");
    meta.className = "hb-contracts-meta";
    meta.innerHTML = `<span class="label">Active Contracts</span><span class="value">${SAMPLE_CONTRACTS.length} / 7</span>`;
    root.appendChild(meta);

    // List
    const list = document.createElement("div");
    list.className = "hb-contracts-list";
    const head = document.createElement("div");
    head.className = "hb-contracts-list-h";
    head.innerHTML = `<span>Contract</span><span style="text-align:right">Progress</span><span style="text-align:right">Cooldown</span>`;
    list.appendChild(head);

    const detail = document.createElement("div");
    detail.className = "hb-contracts-detail";
    const detailTitle = document.createElement("div");
    detailTitle.className = "hb-contracts-detail-title";
    setAcText(detailTitle, "—");
    detail.appendChild(detailTitle);
    const detailBody = document.createElement("div");
    detailBody.className = "hb-contracts-detail-body";
    setAcText(detailBody, "Click a contract to view details.");
    detail.appendChild(detailBody);

    let selected = null;
    function selectRow(c, rowEl) {
      selected = c;
      list.querySelectorAll(".hb-contracts-row.selected").forEach((r) => r.classList.remove("selected"));
      rowEl?.classList.add("selected");
      setAcText(detailTitle, c.name);
      setAcText(detailBody, c.desc);
    }

    if (SAMPLE_CONTRACTS.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-contracts-empty";
      setAcText(empty, "No active contracts. Speak with a contract NPC to accept one.");
      list.appendChild(empty);
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
        list.appendChild(row);
      }
    }
    root.appendChild(list);
    root.appendChild(detail);

    // Actions
    const actions = document.createElement("div");
    actions.className = "hb-contracts-actions";
    for (const a of [
      { id: "abandon", label: "Abandon",  desc: "drop the selected contract" },
      { id: "redo",    label: "Mark Redo", desc: "request a refresh of the selected daily" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-contracts-btn";
      setAcText(btn, a.label);
      btn.title = a.desc;
      btn.addEventListener("click", () => {
        if (!selected) {
          emit(`[contracts] Select a contract first.`);
          return;
        }
        emit(`[contracts] ${a.label} "${selected.name}" — ${a.desc} (game-action not wired yet)`);
      });
      actions.appendChild(btn);
    }
    root.appendChild(actions);

    parentEl.appendChild(root);
    return () => { root.remove(); };
  },
};

export const manifest = {
  id: "contracts-panel",
  name: "Contracts",
  icon: "📋",
  iconHidden: true,
  version: "0.1.0",
  description: "Contracts (gmContractsUI 0x21000069)",
};
