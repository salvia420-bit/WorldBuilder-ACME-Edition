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
// Player journal data isn't exposed yet — placeholder content surfaces
// the parchment frame + tab pattern. When server adds a `journal()`
// method to SessionHandle we wire real entries here.

const STYLE_ID = "hb-journal-view-style";

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
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: url("./data/ui-sprites/0x060022BA.png") repeat;
    }
    .hb-journal-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 1px;
      padding: 4px 4px 0;
    }
    .hb-journal-tab {
      padding: 3px 10px;
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
    }
    .hb-journal-tab:hover { background: var(--hb-overlay-hover); }
    .hb-journal-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    /* Parchment frame: 9-slice composed from the 5 dedicated parchment
       sprites. We render it as nested CSS divs:
         outer (.hb-journal-parchment) is the body fill + has the
         torn TOP edge image absolute-positioned at the top, the
         torn BOTTOM edge at bottom, and vertical strips on L/R. */
    .hb-journal-parchment {
      flex: 1 1 auto;
      position: relative;
      margin: 0 6px 6px;
      padding: 18px 14px;
      background: url("./data/ui-sprites/0x0600126F.png") repeat;
      color: #2a1a08;            /* dark ink colour on the cream parchment */
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(80, 50, 20, 0.7) rgba(0, 0, 0, 0.3);
    }
    /* Torn-edge sprite assignments swapped per user 2026-05-22:
       0x06001273 sprite has its torn frill on the BOTTOM edge of the
       sprite — anchor it to the parchment's TOP and let it overhang
       upward into the dark backdrop. Mirror for 0x06001270 at bottom.
       Strips are positioned ABOVE/BELOW the parchment box (negative
       offsets) so the full frill artwork is visible against the
       dark leather backdrop instead of clipping into the cream fill. */
    .hb-journal-parchment::before,
    .hb-journal-parchment::after {
      content: "";
      position: absolute;
      left: -4px; right: -4px;
      height: 18px;
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
    /* Vertical L/R edge strips. */
    .hb-journal-edge-l,
    .hb-journal-edge-r {
      position: absolute;
      top: 0; bottom: 0;
      width: 8px;
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
    .hb-journal-content {
      position: relative;
      z-index: 1;
      padding: 0 6px;
    }
    .hb-journal-title {
      font-size: 14px;
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
      padding: 24px 12px;
      color: #5a3a18;
      font-style: italic;
      text-align: center;
      font-size: 11px;
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

export const view = {
  name: "Journal",
  nameFor: () => "Quest Journal",
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-journal-root";

    // Companion tab strip: Journal / Contracts (Quest Journal panel +
    // Contracts panel share this pair in retail).
    const tabs = document.createElement("div");
    tabs.className = "hb-journal-tabs";
    for (const t of [
      { id: "journal",   label: "Journal",   current: true },
      { id: "contracts", label: "Contracts", swap: "contracts" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-journal-tab" + (t.current ? " active" : "");
      btn.textContent = t.label;
      if (t.swap) {
        btn.addEventListener("click", () => {
          // PR-DD: keep swap in the same pane the user opened us in.
          const pane = ctx?._pane || window.__mainPanel?.currentPaneOf?.("journal") || "primary";
          window.__mainPanel?.showView?.(t.swap, {}, { pane });
        });
      }
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    // Parchment frame
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
    title.textContent = `Journal of ${playerName}`;
    content.appendChild(title);

    // Real journal data isn't wired — show the placeholder narrative
    // so the parchment frame at least renders representative content.
    if (SAMPLE_ENTRIES.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-journal-empty";
      empty.textContent = "No journal entries yet.";
      content.appendChild(empty);
    } else {
      for (const e of SAMPLE_ENTRIES) {
        const entry = document.createElement("div");
        entry.className = "hb-journal-entry";
        const head = document.createElement("div");
        head.className = "hb-journal-entry-h";
        const t = document.createElement("span");
        t.textContent = e.title;
        head.appendChild(t);
        const s = document.createElement("span");
        s.className = `hb-journal-entry-status ${e.status}`;
        s.textContent = e.status;
        head.appendChild(s);
        entry.appendChild(head);
        const b = document.createElement("div");
        b.className = "hb-journal-entry-body";
        b.textContent = e.body;
        entry.appendChild(b);
        content.appendChild(entry);
      }
      const note = document.createElement("div");
      note.className = "hb-journal-empty";
      note.style.fontSize = "9px";
      note.textContent = "—  Placeholder entries.  Server journal() RPC pending.  —";
      content.appendChild(note);
    }

    parch.appendChild(content);
    root.appendChild(parch);

    parentEl.appendChild(root);
    return () => { root.remove(); };
  },
};

export const manifest = {
  id: "journal-panel",
  name: "Journal",
  icon: "📜",
  iconHidden: true,
  version: "0.1.0",
  description: "Quest Journal (gmJournalUI 0x21000066, parchment 9-slice)",
};
