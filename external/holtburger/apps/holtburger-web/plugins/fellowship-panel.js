// Fellowship panel — view of plugins/main-panel.js. Port of retail
// gmFellowshipUI (layout 0x21000030, 36 elements, 11 image DIDs).
// Bound to the F key.
//
// Two retail states (selected by whether the player is in a fellowship):
//   - "Alone": empty-state copy + Fellowship-Name input + 4 toggle
//     options + Create-Fellowship button. (acpedia screenshot.)
//   - "In fellowship": member list with each member's name + mini
//     vital bars (HP/St/Mn thin sprites 0x0600251C/0x06002520/
//     0x0600251F) + Leave/Recruit/Disband action row.
//
// Player fellowship data isn't exposed via player.stats yet, so we
// render the "Alone" state by default + a debug stub for the "In"
// state (toggleable via window.__hbFellowshipDebug for testing).
//
// Companion tabs Allegiance / Fellowship / Friends / Squelch mirror
// the same set used by plugins/allegiance-panel.js. Fellowship is the
// active tab here; the other tabs swap main-panel views.

import { setAcText } from "../ui/ac_font.js";

const STYLE_ID = "hb-fellow-view-style";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-fellow-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .hb-fellow-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 1px;
      padding: 4px 4px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-fellow-tab {
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
    .hb-fellow-tab:hover { background: var(--hb-overlay-hover); }
    .hb-fellow-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    .hb-fellow-empty {
      flex: 0 0 auto;
      padding: 12px 14px;
      font-size: 11px;
      line-height: 16px;
      color: var(--hb-text-cream);
      text-align: center;
      background: rgba(0, 0, 0, 0.25);
    }
    .hb-fellow-divider {
      height: 4px;
      background: url("./data/ui-sprites/0x06001420.png") center/auto 100% no-repeat;
      margin: 4px 0;
    }
    .hb-fellow-form {
      flex: 0 0 auto;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .hb-fellow-form-h {
      font-size: 10px;
      color: var(--hb-text-cream-bright);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .hb-fellow-input {
      width: 100%;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: var(--hb-font-serif);
      font-size: 11px;
      padding: 3px 6px;
      outline: none;
      box-sizing: border-box;
    }
    .hb-fellow-input:focus { border-color: var(--hb-border-brass); }
    .hb-fellow-opts {
      flex: 0 0 auto;
      padding: 6px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(0, 0, 0, 0.4);
      border-top: 1px solid var(--hb-border-brass-dim);
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-fellow-opt {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      cursor: pointer;
      user-select: none;
    }
    .hb-fellow-opt .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      border: 1px solid var(--hb-border-brass-dim);
    }
    .hb-fellow-opt.on .dot {
      background: var(--hb-text-numeric-green);
      border-color: var(--hb-border-brass);
      box-shadow: 0 0 4px rgba(120, 220, 120, 0.6);
    }
    .hb-fellow-actions {
      flex: 1 1 auto;
      display: flex;
      align-items: flex-end;
      padding: 8px 10px;
    }
    .hb-fellow-create {
      width: 100%;
      padding: 8px 12px;
      font-family: var(--hb-font-serif);
      font-size: 12px;
      letter-spacing: 0.06em;
      color: var(--hb-text-cream);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 1px solid var(--hb-border-brass);
      cursor: pointer;
      text-transform: uppercase;
      user-select: none;
    }
    .hb-fellow-create:hover {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
    }
    .hb-fellow-create:disabled,
    .hb-fellow-create[aria-disabled="true"] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    /* ---- "In fellowship" state — member list ---- */
    .hb-fellow-members {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 4px 6px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-fellow-member {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 3px 4px;
      border-bottom: 1px solid rgba(138, 117, 68, 0.18);
    }
    .hb-fellow-member-h {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
    }
    .hb-fellow-member-h .name { color: var(--hb-text-cream); }
    .hb-fellow-member-h .level { color: var(--hb-text-gold); }
    /* Mini vital bars — 12px tall, brass top/bottom rim baked into the
       sprite (0x0600251C / 20 / 1F variants). Bar width animates via
       a left-anchored gradient mask. */
    .hb-fellow-bar {
      position: relative;
      height: 4px;
      background: url("./data/ui-sprites/0x06002521.png") left/100% 100% no-repeat;
      overflow: hidden;
    }
    .hb-fellow-bar-fill {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      background: left/auto 100% no-repeat;
      transition: width 120ms linear;
    }
    .hb-fellow-bar.health  .hb-fellow-bar-fill { background-image: url("./data/ui-sprites/0x0600251C.png"); }
    .hb-fellow-bar.stamina .hb-fellow-bar-fill { background-image: url("./data/ui-sprites/0x06002520.png"); }
    .hb-fellow-bar.mana    .hb-fellow-bar-fill { background-image: url("./data/ui-sprites/0x0600251F.png"); }
  `;
  document.head.appendChild(style);
}

function emit(msgText, cat = 0) {
  const log = document.getElementById("chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `cat-${cat}`;
  li.dataset.cat = String(cat);
  li.textContent = msgText;
  log.appendChild(li);
}

function buildAloneState(root, fellowshipName, opts, onCreate) {
  const empty = document.createElement("div");
  empty.className = "hb-fellow-empty";
  setAcText(empty, "You do not belong to a fellowship.");
  root.appendChild(empty);

  const divider = document.createElement("div");
  divider.className = "hb-fellow-divider";
  root.appendChild(divider);

  const form = document.createElement("div");
  form.className = "hb-fellow-form";
  const h = document.createElement("div");
  h.className = "hb-fellow-form-h";
  setAcText(h, "Fellowship Name:");
  form.appendChild(h);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hb-fellow-input";
  input.placeholder = "Enter a name…";
  input.maxLength = 32;
  input.value = fellowshipName;
  form.appendChild(input);
  root.appendChild(form);

  const optsBox = document.createElement("div");
  optsBox.className = "hb-fellow-opts";
  const OPT_DEFS = [
    { id: "ignore",     label: "Ignore Fellowship Requests" },
    { id: "autoAccept", label: "Automatically Accept Fellowship Requests" },
    { id: "shareXp",    label: "Share Fellowship Experience and Luminance" },
    { id: "shareLoot",  label: "Share Fellowship Loot" },
  ];
  for (const o of OPT_DEFS) {
    const row = document.createElement("div");
    row.className = "hb-fellow-opt" + (opts[o.id] ? " on" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    row.appendChild(dot);
    const txt = document.createElement("span");
    setAcText(txt, o.label);
    txt.style.color = "var(--hb-text-cream)";
    row.appendChild(txt);
    row.addEventListener("click", () => {
      opts[o.id] = !opts[o.id];
      row.classList.toggle("on", opts[o.id]);
      emit(`[fellowship] ${o.label} = ${opts[o.id] ? "on" : "off"} (client-side only)`);
    });
    optsBox.appendChild(row);
  }
  root.appendChild(optsBox);

  const actions = document.createElement("div");
  actions.className = "hb-fellow-actions";
  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "hb-fellow-create";
  setAcText(createBtn, "Create Fellowship");
  createBtn.addEventListener("click", () => onCreate(input.value.trim()));
  actions.appendChild(createBtn);
  root.appendChild(actions);
}

function buildInState(root, members) {
  const list = document.createElement("div");
  list.className = "hb-fellow-members";
  for (const m of members) {
    const row = document.createElement("div");
    row.className = "hb-fellow-member";
    const head = document.createElement("div");
    head.className = "hb-fellow-member-h";
    const name = document.createElement("span");
    name.className = "name";
    setAcText(name, m.name);
    head.appendChild(name);
    const lvl = document.createElement("span");
    lvl.className = "level";
    setAcText(lvl, `Lv ${m.level ?? "?"}`);
    head.appendChild(lvl);
    row.appendChild(head);
    for (const kind of ["health", "stamina", "mana"]) {
      const bar = document.createElement("div");
      bar.className = `hb-fellow-bar ${kind}`;
      const fill = document.createElement("div");
      fill.className = "hb-fellow-bar-fill";
      const pct = m[kind] != null && m[kind + "Max"] ? Math.max(0, Math.min(100, (m[kind] / m[kind + "Max"]) * 100)) : 100;
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    list.appendChild(row);
  }
  root.appendChild(list);
}

export const view = {
  name: "Fellowship",
  nameFor: () => "Fellowship",
  mount: (parentEl, _ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-fellow-root";

    // Tabs (same set as Allegiance — both share the same companion
    // panel in retail).
    const tabs = document.createElement("div");
    tabs.className = "hb-fellow-tabs";
    for (const t of [
      { id: "allegiance", label: "Allegiance", swap: "allegiance" },
      { id: "fellowship", label: "Fellowship", current: true },
      { id: "friends",    label: "Friends",    swap: null },
      { id: "squelch",    label: "Squelch",    swap: null },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-fellow-tab" + (t.current ? " active" : "");
      setAcText(btn, t.label);
      if (t.swap) {
        btn.addEventListener("click", () => window.__mainPanel?.showView?.(t.swap));
      } else if (!t.current) {
        btn.addEventListener("click", () => emit(`[fellowship] ${t.label} tab not wired yet`));
      }
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    // Fellowship state — alone vs in. Player API doesn't expose this
    // yet, default to alone. Debug toggle via window for testing.
    const debug = window.__hbFellowshipDebug;
    let opts = { ignore: false, autoAccept: false, shareXp: true, shareLoot: true };
    let fellowshipName = "";
    if (debug && Array.isArray(debug.members) && debug.members.length > 0) {
      buildInState(root, debug.members);
    } else {
      buildAloneState(root, fellowshipName, opts, (name) => {
        if (!name) {
          emit("[fellowship] Cannot create — name required.");
          return;
        }
        // GameAction Fellowship_Create isn't exposed yet — log + simulate.
        emit(`[fellowship] Created "${name}" (game-action not wired yet)`);
      });
    }

    parentEl.appendChild(root);
    return () => { root.remove(); };
  },
};

export const manifest = {
  id: "fellowship-panel",
  name: "Fellowship",
  icon: "🤝",
  iconHidden: true,
  version: "0.1.0",
  description: "Fellowship view (gmFellowshipUI 0x21000030)",
};
