// Allegiance panel — view of plugins/main-panel.js. Port of retail
// gmAllegianceUI (layout 0x2100002F, 34 elements, 5 image DIDs).
// Bound to the A key.
//
// Real DAT sprites:
//   0x06001420 — thin gold horizontal divider strip
//   0x06001451 — wider amber/gold separator
//   0x06001AAF — dark mottled background panel
//   0x06004D0B — small black corner accent
//
// Layout structure (300×600 px, from gmAllegianceUI-0x2100002F.json):
//   - Top: patron section (300×45)
//   - Y=45:  monarch section (300×63)
//   - Y=108: rank section (300×45)
//   - Y=153: small status row
//   - Y=171: VASSALS scroll list (279×350 + 16×350 scrollbar)
//   - Y=535: ignore-requests toggle
//   - Y=562: Swear / Break / Kick buttons (88×33 each)
//
// Companion tabs Friends/Squelch share the same layout via gmFloatyPanelUI
// — those are not part of this view yet.

const STYLE_ID = "hb-alleg-view-style";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-alleg-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: url("./data/ui-sprites/0x06001AAF.png") repeat-x;
    }
    .hb-alleg-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 1px;
      padding: 4px 4px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-alleg-tab {
      padding: 3px 8px;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
      border-bottom: none;
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .hb-alleg-tab:hover { background: var(--hb-overlay-hover); }
    .hb-alleg-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    .hb-alleg-section {
      flex: 0 0 auto;
      padding: 4px 8px;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      background: rgba(0, 0, 0, 0.25);
    }
    .hb-alleg-section-h {
      font-size: 9px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 2px;
    }
    .hb-alleg-row {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      font-size: 10px;
      line-height: 14px;
    }
    .hb-alleg-row .label { color: var(--hb-text-cream); }
    .hb-alleg-row .value { color: var(--hb-text-gold); font-variant-numeric: tabular-nums; }
    .hb-alleg-section-divider {
      height: 4px;
      background: url("./data/ui-sprites/0x06001420.png") center/auto 100% no-repeat;
      margin: 4px 0 0;
    }
    .hb-alleg-vassals {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 4px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid var(--hb-border-brass-dim);
      margin: 6px 6px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-alleg-vassals-h {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 4px;
      border-bottom: 1px solid var(--hb-border-brass-dim);
      margin-bottom: 4px;
    }
    .hb-alleg-vassal-row {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      padding: 1px 4px;
      line-height: 16px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    .hb-alleg-vassal-row:last-child { border-bottom: none; }
    .hb-alleg-vassal-row .name { color: var(--hb-text-cream); }
    .hb-alleg-vassal-row .xp { color: var(--hb-text-numeric-green); }
    .hb-alleg-empty {
      padding: 18px 12px;
      color: var(--hb-text-muted);
      font-style: italic;
      text-align: center;
      font-size: 10px;
    }
    .hb-alleg-toggle-row {
      flex: 0 0 auto;
      padding: 4px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      border-top: 1px solid var(--hb-border-brass-dim);
      font-size: 10px;
    }
    .hb-alleg-toggle {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      border: 1px solid var(--hb-border-brass-dim);
      cursor: pointer;
    }
    .hb-alleg-toggle.on {
      background: var(--hb-text-numeric-green);
      border-color: var(--hb-border-brass);
      box-shadow: 0 0 4px rgba(120, 220, 120, 0.6);
    }
    .hb-alleg-actions {
      flex: 0 0 auto;
      padding: 6px 8px;
      display: flex;
      gap: 6px;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.35);
      border-top: 1px solid var(--hb-border-brass-dim);
    }
    .hb-alleg-btn {
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
    .hb-alleg-btn:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-alleg-btn:disabled,
    .hb-alleg-btn[aria-disabled="true"] {
      opacity: 0.5;
      cursor: not-allowed;
      color: var(--hb-text-muted);
    }
  `;
  document.head.appendChild(style);
}

function r(parent, label, value) {
  const row = document.createElement("div");
  row.className = "hb-alleg-row";
  const l = document.createElement("span");
  l.className = "label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "value";
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  parent.appendChild(row);
}
function makeSection(title) {
  const s = document.createElement("div");
  s.className = "hb-alleg-section";
  if (title) {
    const h = document.createElement("div");
    h.className = "hb-alleg-section-h";
    h.textContent = title;
    s.appendChild(h);
  }
  return s;
}
function divider() {
  const d = document.createElement("div");
  d.className = "hb-alleg-section-divider";
  return d;
}

function emit(msgText, cat = 0) {
  // Append a line to the chat log so the user sees feedback. Mirrors
  // index.html's appendChatLine pattern (category 0 = system / green).
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = msgText;
  log.appendChild(li);
}

export const view = {
  name: "Allegiance",
  nameFor: () => "Allegiance",
  mount: (parentEl, _ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-alleg-root";

    // Companion-tab strip — retail puts Allegiance/Fellowship/Friends/
    // Squelch in one panel. Friends + Squelch are not wired yet;
    // clicking them swaps the main-panel view (or stays stub).
    const tabs = document.createElement("div");
    tabs.className = "hb-alleg-tabs";
    for (const t of [
      { id: "allegiance", label: "Allegiance", current: true },
      { id: "fellowship", label: "Fellowship", swap: "fellowship" },
      { id: "friends",    label: "Friends",    swap: null },
      { id: "squelch",    label: "Squelch",    swap: null },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-alleg-tab" + (t.current ? " active" : "");
      btn.textContent = t.label;
      if (t.swap) {
        btn.addEventListener("click", () => {
          window.__mainPanel?.showView?.(t.swap);
        });
      } else if (!t.current) {
        btn.addEventListener("click", () => emit(`[allegiance] ${t.label} tab not wired yet`));
      }
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    // Patron section
    const patronSec = makeSection(null);
    const patronHead = document.createElement("div");
    patronHead.className = "hb-alleg-row";
    patronHead.innerHTML = `<span class="label">Followers:</span><span class="value">0</span>`;
    patronSec.appendChild(patronHead);
    const rankRow = document.createElement("div");
    rankRow.className = "hb-alleg-row";
    rankRow.innerHTML = `<span class="label">Rank:</span><span class="value">[0]</span>`;
    patronSec.appendChild(rankRow);
    patronSec.appendChild(divider());
    root.appendChild(patronSec);

    // Patron / Monarch
    const monarchSec = makeSection("Patron / Monarch");
    r(monarchSec, "Patron", "—");
    r(monarchSec, "Monarch", "—");
    r(monarchSec, "Allegiance", "—");
    monarchSec.appendChild(divider());
    root.appendChild(monarchSec);

    // Allegiance XP
    const xpSec = makeSection("Allegiance XP");
    r(xpSec, "XP Generated", "0");
    r(xpSec, "XP Available", "0");
    xpSec.appendChild(divider());
    root.appendChild(xpSec);

    // Vassals list
    const vassalsBox = document.createElement("div");
    vassalsBox.className = "hb-alleg-vassals";
    const vassalsHead = document.createElement("div");
    vassalsHead.className = "hb-alleg-vassals-h";
    vassalsHead.innerHTML = `<span>Vassals</span><span>XP Produced</span>`;
    vassalsBox.appendChild(vassalsHead);
    const empty = document.createElement("div");
    empty.className = "hb-alleg-empty";
    empty.textContent = "No vassals — you have not yet sworn fealty as a patron.";
    vassalsBox.appendChild(empty);
    root.appendChild(vassalsBox);

    // Ignore-allegiance-requests toggle (per retail wiki)
    const toggleRow = document.createElement("div");
    toggleRow.className = "hb-alleg-toggle-row";
    let ignore = false;
    const toggle = document.createElement("span");
    toggle.className = "hb-alleg-toggle";
    toggle.setAttribute("role", "button");
    toggle.title = "Toggle ignore allegiance requests";
    toggleRow.appendChild(toggle);
    const toggleLabel = document.createElement("span");
    toggleLabel.textContent = "Ignore Allegiance Requests";
    toggleLabel.style.color = "var(--hb-text-cream)";
    toggleRow.appendChild(toggleLabel);
    toggle.addEventListener("click", () => {
      ignore = !ignore;
      toggle.classList.toggle("on", ignore);
      emit(`[allegiance] Ignore-requests ${ignore ? "enabled" : "disabled"} (client-side only)`);
    });
    root.appendChild(toggleRow);

    // Actions
    const actions = document.createElement("div");
    actions.className = "hb-alleg-actions";
    for (const act of [
      { id: "swear", label: "Swear", desc: "swear fealty to selected target" },
      { id: "break", label: "Break", desc: "break fealty (leave your patron)" },
      { id: "kick",  label: "Kick",  desc: "kick a vassal from your allegiance" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-alleg-btn";
      btn.textContent = act.label;
      btn.title = act.desc;
      btn.addEventListener("click", () => {
        // GameAction Swear / Break / Kick aren't exposed yet — log
        // to chat so the user sees the trigger fired.
        emit(`[allegiance] ${act.label}: ${act.desc} (game-action not wired yet)`);
      });
      actions.appendChild(btn);
    }
    root.appendChild(actions);

    parentEl.appendChild(root);

    return () => { root.remove(); };
  },
};

export const manifest = {
  id: "allegiance-panel",
  name: "Allegiance",
  icon: "🛡",
  iconHidden: true,
  version: "0.1.0",
  description: "Allegiance + companion-tab view (gmAllegianceUI 0x2100002F)",
};
