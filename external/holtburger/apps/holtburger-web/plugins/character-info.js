// Character info view — Attributes / Skills / Titles tabs.
// Port of retail gmCharacterInfoUI (0x2100001A parent) with child
// tabs gmAttributeUI (0x2100002C), gmSkillUI (0x2100002D),
// gmCharacterTitleUI (0x2100005E).
//
// Wave 2 surface — mounts as a view of plugins/main-panel.js
// (the shared right-side pane). Toggled via the C key.
//
// Per-skill icons come from SkillTable DAT 0xE000004 (38 skills,
// each with `iconIdHex`). Dump pipeline: WB.Terminal
// `chorizite-dump-skill-table` → `apps/holtburger-web/data/
// skill-table.json` + extracted PNGs under data/ui-sprites/.
//
// Player skill/attribute values come from
// `client.player.stats.skills` and `.attributes` — flat int arrays
// the wasm SessionHandle owns. Per the player-stats inspection at
// 1070 runtime: skills = [id, current, base, trained_state, xp]
// per skill, attributes = [id, current, base, buffed_max] per attr.

import { setAcText } from "../ui/ac_font.js";

const VIEW_STYLE_ID = "hb-charinfo-view-style";

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = VIEW_STYLE_ID;
  style.textContent = `
    .hb-ci-root {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      box-sizing: border-box;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .hb-ci-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 1px;
      padding: 4px 6px 0;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-ci-tab {
      padding: 3px 10px;
      font-size: 10px;
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
    .hb-ci-tab:hover { background: var(--hb-overlay-hover); }
    .hb-ci-tab.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    .hb-ci-head {
      flex: 0 0 auto;
      padding: 6px 8px;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    .hb-ci-head-name {
      font-size: 12px;
      color: var(--hb-text-gold);
      letter-spacing: 0.02em;
    }
    .hb-ci-head-meta {
      font-size: 9px;
      color: var(--hb-text-muted);
    }
    .hb-ci-head-level {
      font-size: 10px;
      color: var(--hb-text-cream);
    }
    .hb-ci-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 4px 4px;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.5);
    }
    .hb-ci-section {
      font-size: 9px;
      color: #6acaca;
      background: rgba(0, 60, 70, 0.35);
      padding: 3px 8px;
      margin: 4px 0 2px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 1px solid rgba(106, 202, 202, 0.4);
    }
    .hb-ci-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 1px 6px;
      font-size: 10px;
      line-height: 18px;
    }
    .hb-ci-row:hover { background: var(--hb-overlay-hover); }
    .hb-ci-icon {
      width: 20px;
      height: 20px;
      flex: 0 0 20px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      image-rendering: pixelated;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
    }
    .hb-ci-name {
      flex: 1 1 auto;
      color: var(--hb-text-cream);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    .hb-ci-value {
      flex: 0 0 auto;
      color: var(--hb-text-numeric-green);
      font-variant-numeric: tabular-nums;
      text-align: right;
      min-width: 30px;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    .hb-ci-footer {
      flex: 0 0 auto;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.45);
      border-top: 1px solid var(--hb-border-brass-dim);
      font-size: 9px;
      color: var(--hb-text-muted);
      display: flex;
      justify-content: space-between;
    }
    .hb-ci-empty {
      padding: 14px 12px;
      color: var(--hb-text-muted);
      font-style: italic;
      text-align: center;
    }
  `;
  document.head.appendChild(style);
}

// Cached skill table — fetched once, reused across mounts.
let skillTablePromise = null;
function loadSkillTable() {
  if (!skillTablePromise) {
    skillTablePromise = fetch("./data/skill-table.json")
      .then((r) => r.json())
      .catch((e) => { console.warn("[char-info] skill-table load failed", e); return { skills: [] }; });
  }
  return skillTablePromise;
}

// AC skill state encoding (player.stats.skills[i*5+3] value):
//   0 = Unusable (some Magic skills if class can't learn)
//   1 = Untrained (default for usable)
//   2 = Trained
//   3 = Specialized

// Attribute name table — mirrors retail AttributeId enum.
const ATTR_NAMES = {
  1: "Strength", 2: "Endurance", 3: "Coordination",
  4: "Quickness", 5: "Focus", 6: "Self",
};
const VITAL_NAMES = { 1: "Health", 3: "Stamina", 5: "Mana" };

function tupleArrayAt(arr, i) {
  // Wasm flat-array stat tuples are exposed as `{ "0": v, "1": v, ... }`
  // when read from a JS Object accessor. Coerce to a real array.
  if (Array.isArray(arr)) return arr[i];
  if (arr && typeof arr === "object") return arr[i];
  return undefined;
}

function getStats() {
  const s = window.__pluginClient?.player?.stats;
  if (!s) return null;
  try {
    return {
      name: s.name,
      attributes: s.attributes,   // [id, cur, base, buffed_max] × 6 + vitals appended?
      skills: s.skills,           // [id, cur, base, trained_state, xp] × 38
      vitals: s.vitals,           // [type, cur, base, buffed_max] × 3
      levelInfo: s.levelInfo,     // [level, xp_total, xp_to_next, ...]
    };
  } catch (_) { return null; }
}

function renderHead(headEl, stats) {
  headEl.innerHTML = "";
  const nameEl = document.createElement("div");
  nameEl.className = "hb-ci-head-name";
  setAcText(nameEl, stats?.name || "—");
  headEl.appendChild(nameEl);
  const levelEl = document.createElement("div");
  levelEl.className = "hb-ci-head-level";
  const level = stats?.levelInfo ? (tupleArrayAt(stats.levelInfo, 0) ?? 1) : 1;
  setAcText(levelEl, `Level ${level}`);
  headEl.appendChild(levelEl);
}

function renderAttributes(bodyEl, stats, _skillTable) {
  bodyEl.innerHTML = "";
  const a = stats?.attributes;
  if (!a) {
    const e = document.createElement("div");
    e.className = "hb-ci-empty";
    setAcText(e, "No attributes yet.");
    bodyEl.appendChild(e);
    return;
  }
  bodyEl.appendChild(section("Attributes"));
  // Attributes are stored as 4-tuples — [id, cur, base, buffed_max].
  // 6 attributes total. Walk in id order.
  for (let i = 0; i < 24; i += 4) {
    const id = tupleArrayAt(a, i);
    if (id == null) break;
    const cur = tupleArrayAt(a, i + 1);
    const max = tupleArrayAt(a, i + 3);
    bodyEl.appendChild(row(null, ATTR_NAMES[id] || `Attr ${id}`, `${cur}/${max}`));
  }
  const v = stats?.vitals;
  if (v) {
    bodyEl.appendChild(section("Vitals"));
    for (let i = 0; i + 3 < (v.length ?? 12); i += 4) {
      const id = tupleArrayAt(v, i);
      if (id == null) break;
      const cur = tupleArrayAt(v, i + 1);
      const max = tupleArrayAt(v, i + 3);
      bodyEl.appendChild(row(null, VITAL_NAMES[id] || `Vital ${id}`, `${cur}/${max}`));
    }
  }
}

function renderSkills(bodyEl, stats, skillTable) {
  bodyEl.innerHTML = "";
  if (!skillTable?.skills?.length) {
    bodyEl.appendChild(emptyMsg("Skill table not loaded."));
    return;
  }
  // Player skills: 5-tuple per entry — [id, current, base, trained_state, xp].
  const playerSkills = stats?.skills;
  const valueByLine = new Map();   // skillId → "cur/base"
  const stateByLine = new Map();
  if (playerSkills) {
    const len = playerSkills.length ?? 0;
    for (let i = 0; i + 4 < len; i += 5) {
      const id = tupleArrayAt(playerSkills, i);
      const cur = tupleArrayAt(playerSkills, i + 1);
      const base = tupleArrayAt(playerSkills, i + 2);
      const trained = tupleArrayAt(playerSkills, i + 3);
      valueByLine.set(id, base != null && cur != null ? `${base}` : "—");
      stateByLine.set(id, trained ?? 0);
    }
  }
  // Group by trained state — Specialized first, then Trained, then Untrained.
  const tiers = { 3: [], 2: [], 1: [], 0: [], 4: [] };
  for (const skill of skillTable.skills) {
    const idInt = skill.skillIdInt;
    const trained = stateByLine.get(idInt) ?? 1;
    (tiers[trained] || tiers[1]).push(skill);
  }
  const tierOrder = [
    { key: 3, label: "Specialized Skills" },
    { key: 2, label: "Trained Skills" },
    { key: 1, label: "Untrained Skills" },
    { key: 0, label: "Unusable" },
    { key: 4, label: "Unusable" },
  ];
  for (const t of tierOrder) {
    const items = tiers[t.key];
    if (!items || items.length === 0) continue;
    bodyEl.appendChild(section(t.label));
    for (const skill of items) {
      const iconUrl = `./data/ui-sprites/${skill.iconIdHex}.png`;
      const value = valueByLine.get(skill.skillIdInt) ?? "—";
      bodyEl.appendChild(row(iconUrl, skill.name, value));
    }
  }
}

function renderTitles(bodyEl, _stats) {
  bodyEl.innerHTML = "";
  bodyEl.appendChild(emptyMsg("Titles list — not wired yet. Server needs to expose titleList()."));
}

function section(text) {
  const el = document.createElement("div");
  el.className = "hb-ci-section";
  setAcText(el, text);
  return el;
}
function emptyMsg(text) {
  const el = document.createElement("div");
  el.className = "hb-ci-empty";
  setAcText(el, text);
  return el;
}
function row(iconUrl, name, value) {
  const el = document.createElement("div");
  el.className = "hb-ci-row";
  const ic = document.createElement("div");
  ic.className = "hb-ci-icon";
  if (iconUrl) ic.style.backgroundImage = `url("${iconUrl}")`;
  el.appendChild(ic);
  const n = document.createElement("div");
  n.className = "hb-ci-name";
  setAcText(n, name);
  el.appendChild(n);
  const v = document.createElement("div");
  v.className = "hb-ci-value";
  setAcText(v, String(value));
  el.appendChild(v);
  return el;
}

export const view = {
  name: "Character",
  nameFor: (ctx) => {
    const stats = getStats();
    const tabLabel = ctx?.tab === "skills" ? "Skills"
                   : ctx?.tab === "titles" ? "Titles"
                   : "Attributes";
    return stats?.name ? `${stats.name} — ${tabLabel}` : tabLabel;
  },
  mount: (parentEl, ctx) => {
    ensureStyles();
    const root = document.createElement("div");
    root.className = "hb-ci-root";

    const tabsEl = document.createElement("div");
    tabsEl.className = "hb-ci-tabs";
    const tabBtns = {};
    const TABS = [
      { id: "attributes", label: "Attributes" },
      { id: "skills",     label: "Skills" },
      { id: "titles",     label: "Titles" },
    ];
    let activeTab = ctx?.tab || "skills";
    for (const t of TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hb-ci-tab" + (t.id === activeTab ? " active" : "");
      btn.dataset.tab = t.id;
      setAcText(btn, t.label);
      btn.addEventListener("click", () => setTab(t.id));
      tabsEl.appendChild(btn);
      tabBtns[t.id] = btn;
    }
    root.appendChild(tabsEl);

    const headEl = document.createElement("div");
    headEl.className = "hb-ci-head";
    root.appendChild(headEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "hb-ci-body";
    root.appendChild(bodyEl);

    const footerEl = document.createElement("div");
    footerEl.className = "hb-ci-footer";
    const footL = document.createElement("span");
    setAcText(footL, "—");
    const footR = document.createElement("span");
    setAcText(footR, "");
    footerEl.appendChild(footL);
    footerEl.appendChild(footR);
    root.appendChild(footerEl);

    parentEl.appendChild(root);

    let skillTable = null;
    function setTab(id) {
      activeTab = id;
      for (const k of Object.keys(tabBtns)) {
        tabBtns[k].classList.toggle("active", k === id);
      }
      rerender();
    }
    function rerender() {
      const stats = getStats();
      renderHead(headEl, stats);
      switch (activeTab) {
        case "attributes": renderAttributes(bodyEl, stats, skillTable); break;
        case "skills":     renderSkills(bodyEl, stats, skillTable); break;
        case "titles":     renderTitles(bodyEl, stats); break;
      }
      // Footer: skill credits if available.
      const lv = stats?.levelInfo;
      setAcText(footL, lv ? `XP: ${tupleArrayAt(lv, 1) ?? 0}` : "—");
      setAcText(footR, lv ? `Next: ${tupleArrayAt(lv, 2) ?? 0}` : "");
    }

    // Load skill table then render.
    loadSkillTable().then((st) => { skillTable = st; rerender(); });
    rerender();

    // Subscribe to player stats updates so live skill changes reflect.
    let off = null;
    const client = window.__pluginClient;
    if (client?.events?.on) {
      const onStats = () => rerender();
      client.events.on("playerStatsUpdated", onStats);
      off = () => { try { client.events.off("playerStatsUpdated", onStats); } catch (_) {} };
    }

    return () => {
      if (off) off();
      root.remove();
    };
  },
};
