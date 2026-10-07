// Character view — Attributes / Skills / Titles in ONE pane.
//
// Retail anatomy (HUD overhaul 2026-10-05): gmAttributeUI (0x2100002C)
// and gmSkillUI (0x2100002D) are both gmStatManagementUI subclasses that
// draw the StatManagement_Template (layout 0x21000045, 300×337):
//
//   header  0x10000230 300×105  Name 0x10000231 / Title 0x10000232 /
//                               PKStatus 0x10000233 / TotalXP 0x10000234-5 /
//                               XPToLevelMeter 0x10000236 (frame 0x060011A6,
//                               red fill 0x060011A5) | divider 0x10000239
//                               (0x06004CB8) | "Character Level" 0x1000023A
//                               + big value 0x1000023B
//   divider 0x1000023C 300×7  (0x06004CC7)
//   list    0x1000023D 300×160 InfoRegion rows 282×20: icon 0x10000129
//                               20×20, label 0x1000012A @25, value
//                               0x1000012B @175; section headers
//                               Specialized 0x06000F90 / Trained 0x06000F86 /
//                               Untrained 0x06000F98 / Unusable 0x06000F89
//   divider 0x1000023F 300×7
//   footer  0x10000240 300×55   Title 0x1000024E, LineOne 0x10000242/43,
//                               LineTwo 0x10000244/45, Raise10 0x100005EB
//                               (0x0600712B) above Raise 0x10000246
//                               (0x06004CB6), both 30×26 at x=260
//
// Holtburger keeps the shared main-panel title strip, so the template
// mounts in the ~300×325 body below it; a kit tab strip on top switches
// Attributes / Skills / Titles (retail opened these as separate panels
// from the toolbar). The pane is a flex column — header, list and footer
// keep their retail proportions and only the list (hbk-scroll) gives up
// height, so nothing is ever clipped off the bottom.
//
// Behaviour (decomp-matched):
//   * gmSkillUI::RebuildSkillList — Specialized / Trained / Untrained /
//     Unusable sections, alphabetical inside each (AddSortedSkill);
//     SAC 1 with min_level > 1 counts as Unusable.
//   * gmStatManagementUI::UpdateExperience — "XP for next level" =
//     ExperienceToLevel(lvl+1) − total; the red meter fills by progress
//     through the current level.
//   * gm{Skill,Attribute}UI::DisplayDefaultFooter / DisplaySelection
//     Footer_{Trained,Untrained,Attribute,Vital} — the footer shows the
//     selected stat ("Name: value"), its raise cost and the pool it
//     spends; +1 (RaiseSelection) and +10 (Raise10Selection, cost from
//     GetCostToRaise10) send ONE request with the XP amount. Untrained
//     skills train for credits after a confirmation
//     (gmSkillUI::TrainSkill → TrainSkillDialogCallback); +10 is hidden.
//
// Hotkeys: F1 toggles this view (last-used tab, Attributes first time);
// F11 opens it on the Skills tab (train-skills manifest hotkey →
// app/plugin_bar.js). `window.__openCharacterTab(tab)` is the shared
// entry point for toolbar buttons (Attributes / Skills).
//
// Data: `client.player.stats` stride arrays (src/lib.rs
// publish_player_stats_snapshot): attributes [type, current, base,
// ranks]×6, vitals [type, current, base, buffed_max]×3, skills [type,
// current, base, ranks, training, next_rank_cost]×N, levelInfo [level,
// xp_lo, xp_hi, unspent_lo, unspent_hi, lum_lo, lum_hi]. Skill names /
// icons / costs from data/skill-table.json (SkillTable 0x0E000004); XP
// curves from data/xp-tables-full.json (ExperienceTable 0x0E000018).

import { setAcText, COMPACT_FONT_ID, HEADING_FONT_ID } from "../ui/ac_font.js";
import {
  TRAINING, decideTrainAction, statRaiseCost, skillSpentXp,
  estimateVitalRanks, levelProgress, skillGroupFor,
} from "./train-skills.js";

const VIEW_STYLE_ID = "hb-charinfo-view-style";
const SP = "./data/ui-sprites";

// Retail text colours (StatManagement InfoRegion label / value).
const C_NAME = "#eadfc4";
const C_DIM = "#a8a090";
const C_GOLD = "#f3d27a";
const C_VALUE = "#8aef6d";
const C_BUFFED = "#7fd6ff";
const C_DEBUFFED = "#ff7a5c";
const C_UNUSABLE = "#8a8270";

const TABS = [
  { id: "attributes", label: "Attributes", title: "Attributes" },
  { id: "skills", label: "Skills", title: "Skills" },
  { id: "titles", label: "Titles", title: "Character Titles" },
];
const TAB_IDS = new Set(TABS.map((t) => t.id));

// Last tab the player looked at — F1 reopens it (retail remembered the
// open sub-panel per session). First open defaults to Attributes.
let lastTab = "attributes";
function resolveTab(ctx) {
  const t = ctx?.tab;
  return TAB_IDS.has(t) ? t : lastTab;
}
function tabMeta(id) { return TABS.find((t) => t.id === id) ?? TABS[0]; }

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  if (document.getElementById(VIEW_STYLE_ID)) { stylesInjected = true; return; }
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = VIEW_STYLE_ID;
  style.textContent = `
    .hb-ci-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      box-sizing: border-box; overflow: hidden;
      pointer-events: auto; user-select: none;
      color: var(--hbk-text); font-family: var(--hbk-font); font-size: 12px;
      background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
    }
    .hb-ci-tabs { flex: 0 0 auto; }
    /* Header — StatManagement_Header (0x10000230), compressed from 105px. */
    .hb-ci-head { flex: 0 0 auto; display: flex; align-items: stretch; padding: 3px 0 3px 6px; }
    .hb-ci-head-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; padding-right: 6px; }
    .hb-ci-name { height: 16px; overflow: hidden; display: flex; align-items: center; }
    .hb-ci-sub { height: 11px; overflow: hidden; display: flex; align-items: center; }
    .hb-ci-sub:empty, .hb-ci-sub[data-empty="1"] { display: none; }
    .hb-ci-kv { display: flex; align-items: center; justify-content: space-between; gap: 6px; height: 13px; overflow: hidden; }
    .hb-ci-kv > * { display: flex; align-items: center; min-width: 0; }
    .hb-ci-xpmeter {
      position: relative; height: 15px; margin-top: 1px;
      background: url("${SP}/0x060011A6.png") center / 100% 100% no-repeat;
    }
    .hb-ci-xpmeter-fill {
      position: absolute; left: 1px; right: 1px; top: 1px; bottom: 1px;
      background: url("${SP}/0x060011A5.png") center / 100% 100% no-repeat;
      clip-path: inset(0 calc(100% - var(--hb-ci-fill, 0%)) 0 0);
      transition: clip-path 200ms ease-out;
    }
    .hb-ci-xpmeter-label {
      position: absolute; inset: 0; padding: 0 4px;
      display: flex; align-items: center; justify-content: space-between; gap: 4px;
    }
    .hb-ci-xpmeter[data-hidden="1"] { display: none; }
    .hb-ci-vdiv { flex: 0 0 5px; background: url("${SP}/0x06004CB8.png") center top / 5px 10px repeat-y; }
    .hb-ci-level {
      flex: 0 0 62px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 2px;
    }
    .hb-ci-rule { flex: 0 0 7px; background: url("${SP}/0x06004CC7.png") left center / 10px 7px repeat-x; }
    /* List — StatManagement_List (0x1000023D). */
    .hb-ci-list { flex: 1 1 auto; min-height: 40px; outline: none; }
    .hb-ci-group {
      flex: 0 0 20px; height: 20px; box-sizing: border-box;
      display: flex; align-items: center; padding-left: 6px;
      background: url("${SP}/0x06000F98.png") left center / 100% 100% no-repeat;
    }
    .hb-ci-group[data-group="specialized"] { background-image: url("${SP}/0x06000F90.png"); }
    .hb-ci-group[data-group="trained"] { background-image: url("${SP}/0x06000F86.png"); }
    .hb-ci-group[data-group="untrained"] { background-image: url("${SP}/0x06000F98.png"); }
    .hb-ci-group[data-group="unusable"] { background-image: url("${SP}/0x06000F89.png"); }
    .hb-ci-group[data-group="plain"] {
      background: linear-gradient(90deg, rgba(243, 210, 122, 0.16), transparent 85%);
      border-top: 1px solid rgba(243, 210, 122, 0.25);
      border-bottom: 1px solid rgba(0, 0, 0, 0.8);
    }
    .hb-ci-row { height: 20px; min-height: 20px; box-sizing: border-box; padding: 0 6px 0 4px; gap: 5px; }
    .hb-ci-icon {
      flex: 0 0 20px; width: 20px; height: 20px;
      background: center / contain no-repeat; image-rendering: pixelated;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.7));
    }
    .hb-ci-rname { flex: 1 1 auto; min-width: 0; overflow: hidden; display: flex; align-items: center; }
    .hb-ci-rval { flex: 0 0 auto; min-width: 34px; display: flex; justify-content: flex-end; align-items: center; }
    .hb-ci-row[data-current-title="1"] .hb-ci-rval { min-width: 0; }
    .hb-ci-list .hbk-empty { padding: 22px 12px; }
    /* Footer — StatManagement_Footer (0x10000240). */
    .hb-ci-foot {
      flex: 0 0 auto; display: flex; align-items: stretch; gap: 6px;
      min-height: 54px; box-sizing: border-box; padding: 2px 6px 3px 8px;
    }
    .hb-ci-foot-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
    .hb-ci-foot-title { height: 16px; overflow: hidden; display: flex; align-items: center; }
    .hb-ci-foot-line { display: flex; align-items: center; justify-content: space-between; gap: 6px; height: 14px; overflow: hidden; }
    .hb-ci-foot-line > * { display: flex; align-items: center; min-width: 0; }
    .hb-ci-foot-btns { flex: 0 0 30px; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
    .hb-ci-foot-btns[data-mode="title"] { flex: 0 0 auto; }
    .hb-ci-raise {
      width: 30px; height: 26px; padding: 0; margin: 0; border: 0;
      background: center / 100% 100% no-repeat; cursor: pointer;
      image-rendering: pixelated;
    }
    .hb-ci-raise[data-step="1"] { background-image: url("${SP}/0x06004CB6.png"); }
    .hb-ci-raise[data-step="10"] { background-image: url("${SP}/0x0600712B.png"); }
    .hb-ci-raise:hover:not(:disabled), .hb-ci-raise:focus-visible:not(:disabled) {
      filter: brightness(1.18) drop-shadow(0 0 3px rgba(140, 255, 110, 0.55));
    }
    .hb-ci-raise[data-step="1"]:active:not(:disabled) { background-image: url("${SP}/0x06004CB7.png"); }
    .hb-ci-raise[data-step="10"]:active:not(:disabled) { background-image: url("${SP}/0x0600712C.png"); }
    .hb-ci-raise:disabled { filter: grayscale(1) brightness(0.5); cursor: default; }
    .hb-ci-raise[data-hidden="1"] { visibility: hidden; }
    .hb-ci-setbtn { min-width: 74px; }
  `;
  document.head.appendChild(style);
}

// ─── Data ────────────────────────────────────────────────────────────

let skillTablePromise = null;
let skillTable = null;
function loadSkillTable() {
  if (!skillTablePromise) {
    skillTablePromise = fetch("./data/skill-table.json")
      .then((r) => r.json())
      .then((t) => { skillTable = t; return t; })
      .catch((e) => {
        console.warn("[char-info] skill-table load failed", e);
        skillTablePromise = null; // retryable
        return null;
      });
  }
  return skillTablePromise;
}

// XP curves. xp-tables-full.json carries levels + skill curves; the
// boot-time xp-tables.json prefetch (attributes + vitals only, see
// app/plugin_bar.js) is the fallback so raises still work if the full
// table 404s on an old dist.
let xpTables = null;
let xpTablesPromise = null;
function loadXpTables() {
  if (xpTables) return Promise.resolve(xpTables);
  if (xpTablesPromise) return xpTablesPromise;
  xpTablesPromise = fetch("./data/xp-tables-full.json")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(async (full) => {
      if (full && Array.isArray(full.attributes)) { xpTables = full; return full; }
      const basic = (typeof window !== "undefined" && window.__xpTablesPromise)
        ? await window.__xpTablesPromise
        : await fetch("./data/xp-tables.json").then((r) => r.json()).catch(() => null);
      if (basic) xpTables = basic;
      else xpTablesPromise = null; // retryable
      return basic;
    });
  return xpTablesPromise;
}

const ATTR_NAMES = {
  1: "Strength", 2: "Endurance", 3: "Quickness",
  4: "Coordination", 5: "Focus", 6: "Self",
};
// Retail attribute panel order (Str, End, Coord, Quick, Focus, Self).
const ATTR_ORDER = [1, 2, 4, 3, 5, 6];
const VITAL_NAMES = { 1: "Health", 3: "Stamina", 5: "Mana" };
// DBObj.EnumIDMap UIAttributeIcons (0x25000006) / UIAttribute2ndIcons
// (0x25000007), exported to data/ui-sprites/.
const ATTR_ICONS = {
  1: "0x060002C8", 2: "0x060002C4", 3: "0x060002C6",
  4: "0x060002C9", 5: "0x060002C5", 6: "0x060002C7",
};
const VITAL_ICONS = { 1: "0x06004C3B", 3: "0x06004C3C", 5: "0x06004C3D" };

// CharacterTitle display names (ACE CharacterTitle enum 0..30, spelled
// as the client's CharacterTitle StringTable 0x2300000E shows them).
// Ids past this range fall back to "Title #N" until the string table is
// wired (the DAT keys titles by hashed enum name).
const TITLE_NAMES = {
  1: "Adventurer", 2: "Archer", 3: "Blademaster", 4: "Enchanter",
  5: "Life Mage", 6: "Sorcerer", 7: "Vagabond", 8: "Warrior",
  9: "Bow Hunter", 10: "Life Caster", 11: "Soldier", 12: "Swashbuckler",
  13: "War Mage", 14: "Wayfarer", 15: "Abhorrent Warrior", 16: "Alchemist",
  17: "Annihilator", 18: "Apothecary", 19: "Arctic Adventurer",
  20: "Arctic Mattekar Annihilator", 21: "Artifex", 22: "Axe Warrior",
  23: "Ballisteer", 24: "Bane of the Remoran", 25: "Blood Shreth Butcher",
  26: "Bookbinder", 27: "Brawler", 28: "Butcher of the North", 29: "Cabalist",
  30: "Carpenter",
};
function titleName(id) {
  if (!id) return "";
  return TITLE_NAMES[id] ?? `Title #${id}`;
}

function toArray(a) {
  if (!a) return [];
  if (Array.isArray(a)) return a;
  try { return Array.from(a); } catch (_) { return []; }
}

// Snapshot → plain arrays. `client.player.stats` is a plain copy since
// 2026-10-07 (plugins/api.js frees the wasm PlayerStatsSnapshot itself);
// the `free?.()` below stays for hosts that still hand out the raw box.
function getStats() {
  let s = null;
  try { s = window.__pluginClient?.player?.stats ?? null; } catch (_) { s = null; }
  if (!s) return null;
  try {
    return {
      name: s.name || "",
      attributes: toArray(s.attributes),
      vitals: toArray(s.vitals),
      skills: toArray(s.skills),
      levelInfo: toArray(s.levelInfo),
    };
  } catch (_) {
    return null;
  } finally {
    try { s.free?.(); } catch (_) {}
  }
}

function u64(lo, hi) { return (hi >>> 0) * 0x1_0000_0000 + (lo >>> 0); }
function getAvailableXp(stats) {
  const lv = stats?.levelInfo;
  return lv && lv.length >= 5 ? u64(lv[3], lv[4]) : 0;
}
function getTotalXp(stats) {
  const lv = stats?.levelInfo;
  return lv && lv.length >= 3 ? u64(lv[1], lv[2]) : 0;
}
function getLevel(stats) {
  const lv = stats?.levelInfo;
  return lv && lv.length >= 1 ? (lv[0] >>> 0) : 0;
}
function getAvailableCredits() {
  try { return window.__pluginClient?.player?.skillCredits >>> 0; }
  catch (_) { return 0; }
}
function getHandle() {
  return window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
}
function fmt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

function readTitleSnapshot() {
  const out = { currentId: 0, ids: [] };
  let snap = null;
  try {
    snap = getHandle()?.playerTitle?.() ?? null;
    if (snap) {
      out.currentId = snap.currentTitleId >>> 0;
      for (const v of toArray(snap.titleIds)) if (v >>> 0) out.ids.push(v >>> 0);
    }
  } catch (_) { /* pre-snapshot */ }
  finally { try { snap?.free?.(); } catch (_) {} }
  return out;
}

// ─── Row models ──────────────────────────────────────────────────────

function valueColor(cur, base) {
  if (cur > base) return C_BUFFED;
  if (cur < base) return C_DEBUFFED;
  return C_VALUE;
}

function buildAttributeModel(stats, xp) {
  const items = [];
  const a = stats?.attributes ?? [];
  const byId = new Map();
  const attrBase = {};
  for (let i = 0; i + 3 < a.length; i += 4) {
    byId.set(a[i], { cur: a[i + 1], base: a[i + 2], ranks: a[i + 3] });
    attrBase[a[i]] = a[i + 2];
  }
  if (byId.size === 0) return items;
  items.push({ key: "h:attributes", kind: "header", group: "plain", label: "Attributes" });
  for (const id of ATTR_ORDER) {
    const r = byId.get(id);
    if (!r) continue;
    const table = xp?.attributes ?? null;
    const spent = Array.isArray(table) ? (table[r.ranks] ?? 0) : 0;
    items.push({
      key: `attribute:${id}`, kind: "attribute", id,
      name: ATTR_NAMES[id] ?? `Attribute ${id}`,
      icon: ATTR_ICONS[id] ? `${SP}/${ATTR_ICONS[id]}.png` : null,
      value: String(r.cur), valueColor: valueColor(r.cur, r.base),
      current: r.cur, base: r.base,
      tip: r.cur !== r.base ? `Base ${r.base}, currently ${r.cur}` : `Base ${r.base}`,
      cost1: statRaiseCost(table, r.ranks, spent, 1),
      cost10: statRaiseCost(table, r.ranks, spent, 10),
    });
  }
  const v = stats?.vitals ?? [];
  if (v.length >= 4) {
    items.push({ key: "h:vitals", kind: "header", group: "plain", label: "Vitals" });
    for (let i = 0; i + 3 < v.length; i += 4) {
      const id = v[i], cur = v[i + 1], base = v[i + 2], max = v[i + 3];
      const table = xp?.vitals ?? null;
      const ranks = estimateVitalRanks(id, base, attrBase);
      const spent = Array.isArray(table) ? (table[ranks] ?? 0) : 0;
      items.push({
        key: `vital:${id}`, kind: "vital", id,
        name: VITAL_NAMES[id] ?? `Vital ${id}`,
        icon: VITAL_ICONS[id] ? `${SP}/${VITAL_ICONS[id]}.png` : null,
        value: `${cur}/${max}`, valueColor: valueColor(max, base),
        current: max, base,
        tip: `Maximum ${max} (base ${base}), currently ${cur}`,
        cost1: statRaiseCost(table, ranks, spent, 1),
        cost10: statRaiseCost(table, ranks, spent, 10),
      });
    }
  }
  return items;
}

const SKILL_GROUPS = [
  { key: "specialized", label: "Specialized Skills" },
  { key: "trained", label: "Trained Skills" },
  { key: "untrained", label: "Untrained Skills" },
  { key: "unusable", label: "Unusable Skills" },
];

function buildSkillModel(stats, table, xp) {
  const catalog = table?.skills ?? [];
  if (!catalog.length) return [];
  const s = stats?.skills ?? [];
  const snap = new Map();
  for (let i = 0; i + 5 < s.length; i += 6) {
    snap.set(s[i], { cur: s[i + 1], base: s[i + 2], ranks: s[i + 3], training: s[i + 4], marginal: s[i + 5] });
  }
  const groups = { specialized: [], trained: [], untrained: [], unusable: [] };
  for (const sk of catalog) {
    const id = sk.skillIdInt;
    const r = snap.get(id) ?? null;
    const training = r?.training ?? TRAINING.UNUSABLE;
    const group = skillGroupFor(training, sk.minLevel);
    let cost1 = null, cost10 = null;
    if (r && (training === TRAINING.TRAINED || training === TRAINING.SPECIALIZED)) {
      const curve = training === TRAINING.SPECIALIZED ? xp?.specializedSkills : xp?.trainedSkills;
      if (r.marginal > 0) {
        cost1 = { cost: r.marginal >>> 0, ranks: 1 };
        const spent = skillSpentXp(curve, r.ranks, r.marginal);
        cost10 = statRaiseCost(curve, r.ranks, spent, 10);
        // The server's marginal is authoritative; if the local curve
        // disagrees with it (stale dist data) never offer a +10 that is
        // cheaper than +1 — hide it instead of sending a wrong amount.
        if (cost10 && cost10.cost < cost1.cost) cost10 = null;
      }
    }
    const cur = r?.cur ?? 0, base = r?.base ?? 0;
    groups[group].push({
      key: `skill:${id}`, kind: "skill", id, group, training,
      name: sk.name ?? `Skill ${id}`,
      icon: sk.iconIdHex ? `${SP}/${sk.iconIdHex}.png` : null,
      value: r ? String(cur) : "",
      valueColor: group === "unusable" ? C_UNUSABLE : valueColor(cur, base),
      nameColor: group === "unusable" ? C_UNUSABLE : C_NAME,
      current: cur, base,
      tip: [sk.name, sk.description, r ? (cur !== base ? `Base ${base}, currently ${cur}` : `Base ${base}`) : ""]
        .filter(Boolean).join("\n"),
      trainedCost: sk.trainedCost ?? 0,
      cost1, cost10,
    });
  }
  const items = [];
  for (const g of SKILL_GROUPS) {
    const rows = groups[g.key];
    if (!rows.length) continue;
    rows.sort((a, b) => a.name.localeCompare(b.name));
    items.push({ key: `h:${g.key}`, kind: "header", group: g.key, label: g.label });
    items.push(...rows);
  }
  return items;
}

function buildTitleModel(titles) {
  const items = [];
  const ids = [...titles.ids].sort((a, b) => titleName(a).localeCompare(titleName(b)));
  for (const id of ids) {
    items.push({
      key: `title:${id}`, kind: "title", id,
      name: titleName(id),
      value: id === titles.currentId ? "Current" : "",
      valueColor: C_GOLD,
      tip: id === titles.currentId ? "Your displayed title" : "Select, then Set Title to display it",
    });
  }
  return items;
}

// ─── Footer model (pure — exported for tests) ────────────────────────

/**
 * Footer contents for the current selection, mirroring retail
 * gmSkillUI / gmAttributeUI DisplayDefaultFooter / DisplaySelectionFooter_*.
 * Returns `{ title, line1:[label,value], line2:[label,value], raise1,
 * raise10 }` where raise* is `{ enabled, hidden, cost, ranks, action }`.
 */
export function footerModel(tab, rec, pools) {
  const xp = pools?.availableXp ?? 0;
  const credits = pools?.credits ?? 0;
  const off = { enabled: false, hidden: false };
  const hidden = { enabled: false, hidden: true };
  const xpLine = ["Unassigned XP:", fmt(xp)];
  const credLine = ["Skill Credits:", fmt(credits)];
  if (!rec) {
    if (tab === "skills") {
      return { title: "Select a Skill to Improve", line1: credLine, line2: xpLine, raise1: off, raise10: off };
    }
    return { title: "Select an Attribute to Improve", line1: xpLine, line2: credLine, raise1: off, raise10: off };
  }
  if (rec.kind === "skill" && rec.group === "untrained") {
    const cost = rec.trainedCost >>> 0;
    return {
      title: rec.name,
      line1: ["Credits to Train:", cost ? fmt(cost) : "—"],
      line2: credLine,
      raise1: { enabled: cost > 0 && cost <= credits, hidden: false, cost, ranks: 0, action: "train" },
      raise10: hidden,
    };
  }
  if (rec.kind === "skill" && rec.group === "unusable") {
    return { title: rec.name, line1: ["Cannot be trained", ""], line2: credLine, raise1: off, raise10: hidden };
  }
  const c1 = rec.cost1, c10 = rec.cost10;
  const atMax = !c1;
  return {
    // DisplaySelectionFooter_Trained: SetText(title, "%s: %d", name, buffed value).
    title: `${rec.name}: ${rec.current}`,
    line1: ["XP to Raise:", atMax ? "Maximum" : fmt(c1.cost)],
    line2: xpLine,
    raise1: { enabled: !atMax && c1.cost <= xp, hidden: false, cost: c1?.cost ?? 0, ranks: 1, action: "raise" },
    raise10: c10 && c10.ranks > 1
      ? { enabled: c10.cost <= xp, hidden: false, cost: c10.cost, ranks: c10.ranks, action: "raise" }
      : { enabled: false, hidden: atMax, cost: 0, ranks: 0, action: "raise" },
  };
}

// ─── Confirm helper ──────────────────────────────────────────────────

async function confirmAction(title, message, confirmLabel) {
  try {
    if (typeof window.__modalConfirm === "function") {
      return !!(await window.__modalConfirm({ title, message, confirmLabel, cancelLabel: "Cancel" }));
    }
  } catch (_) { /* fall through */ }
  if (typeof window.confirm === "function") return window.confirm(message);
  return true;
}

// ─── View ────────────────────────────────────────────────────────────

let activeInstance = null;

/**
 * Open the character pane on `tab`. Toggles closed when the pane is
 * already showing that tab (toolbar-button semantics); switches tab in
 * place when it is showing another one.
 */
export function openCharacterTab(tab, { toggle = true } = {}) {
  const want = TAB_IDS.has(tab) ? tab : "attributes";
  const mp = window.__mainPanel;
  if (!mp) return;
  if (activeInstance && mp.isOpen?.() && mp.currentViewId?.() === "character") {
    if (toggle && activeInstance.getTab() === want) { mp.closeView?.(); return; }
    activeInstance.setTab(want);
    return;
  }
  mp.showView?.("character", { tab: want });
}
if (typeof window !== "undefined") window.__openCharacterTab = openCharacterTab;

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export const view = {
  name: "Attributes",
  nameFor: (ctx) => tabMeta(resolveTab(ctx)).title,
  mount: (parentEl, ctx) => {
    ensureStyles();
    let activeTab = resolveTab(ctx);
    lastTab = activeTab;

    const root = el("div", "hb-ci-root");

    // Tabs — kit tabs; the selected one mirrors the panel title.
    const tabsEl = el("div", "hbk-tabs hb-ci-tabs");
    tabsEl.setAttribute("role", "tablist");
    const tabBtns = {};
    for (const t of TABS) {
      const b = el("button", "hbk-tab");
      b.type = "button";
      b.dataset.tab = t.id;
      b.dataset.label = t.label;
      b.setAttribute("role", "tab");
      b.textContent = t.label;
      b.addEventListener("click", () => setTab(t.id));
      tabsEl.appendChild(b);
      tabBtns[t.id] = b;
    }
    root.appendChild(tabsEl);

    // Header.
    const head = el("div", "hb-ci-head");
    head.dataset.el = "0x10000230";
    const headMain = el("div", "hb-ci-head-main");
    const nameEl = el("div", "hb-ci-name"); nameEl.dataset.el = "0x10000231";
    const subEl = el("div", "hb-ci-sub"); subEl.dataset.el = "0x10000232";
    const xpRow = el("div", "hb-ci-kv");
    const xpK = el("span"); const xpV = el("span");
    xpRow.append(xpK, xpV);
    const meter = el("div", "hb-ci-xpmeter"); meter.dataset.el = "0x10000236";
    const meterFill = el("div", "hb-ci-xpmeter-fill");
    const meterLabel = el("div", "hb-ci-xpmeter-label");
    const meterK = el("span"); const meterV = el("span");
    meterLabel.append(meterK, meterV);
    meter.append(meterFill, meterLabel);
    headMain.append(nameEl, subEl, xpRow, meter);
    const vdiv = el("div", "hb-ci-vdiv"); vdiv.dataset.el = "0x10000239";
    const levelBox = el("div", "hb-ci-level");
    const levelK = el("span"); levelK.dataset.el = "0x1000023A";
    const levelV = el("span"); levelV.dataset.el = "0x1000023B";
    levelBox.append(levelK, levelV);
    head.append(headMain, vdiv, levelBox);
    root.appendChild(head);
    setAcText(xpK, "Total Experience (XP):", { color: C_DIM, fontId: COMPACT_FONT_ID });
    setAcText(meterK, "XP for next level:", { color: "#ffffff", fontId: COMPACT_FONT_ID });
    setAcText(levelK, "Level", { color: C_GOLD, fontId: COMPACT_FONT_ID });

    const ruleTop = el("div", "hb-ci-rule"); ruleTop.dataset.el = "0x1000023C";
    root.appendChild(ruleTop);

    const list = el("div", "hbk-scroll hbk-list hb-ci-list");
    list.dataset.el = "0x1000023D";
    list.setAttribute("role", "listbox");
    root.appendChild(list);

    const ruleBot = el("div", "hb-ci-rule"); ruleBot.dataset.el = "0x1000023F";
    root.appendChild(ruleBot);

    // Footer.
    const foot = el("div", "hb-ci-foot"); foot.dataset.el = "0x10000240";
    const footText = el("div", "hb-ci-foot-text");
    const footTitle = el("div", "hb-ci-foot-title"); footTitle.dataset.el = "0x1000024E";
    const line1 = el("div", "hb-ci-foot-line");
    const l1k = el("span"); l1k.dataset.el = "0x10000242";
    const l1v = el("span"); l1v.dataset.el = "0x10000243";
    line1.append(l1k, l1v);
    const line2 = el("div", "hb-ci-foot-line");
    const l2k = el("span"); l2k.dataset.el = "0x10000244";
    const l2v = el("span"); l2v.dataset.el = "0x10000245";
    line2.append(l2k, l2v);
    footText.append(footTitle, line1, line2);
    const btns = el("div", "hb-ci-foot-btns");
    const raise10 = el("button", "hb-ci-raise");
    raise10.type = "button"; raise10.dataset.step = "10"; raise10.dataset.el = "0x100005EB";
    raise10.setAttribute("aria-label", "Raise 10");
    const raise1 = el("button", "hb-ci-raise");
    raise1.type = "button"; raise1.dataset.step = "1"; raise1.dataset.el = "0x10000246";
    raise1.setAttribute("aria-label", "Raise 1");
    const setTitleBtn = el("button", "hbk-btn hb-ci-setbtn");
    setTitleBtn.type = "button";
    setTitleBtn.textContent = "Set Title";
    btns.append(raise10, raise1, setTitleBtn);
    foot.append(footText, btns);
    root.appendChild(foot);

    parentEl.appendChild(root);

    // ── State ──
    let stats = null;
    let model = [];             // current list items
    let renderedKeys = "";      // key signature of the rendered list
    const rowEls = new Map();   // key → row element
    let selectedKey = null;
    let awaitingRaise = false;  // gmStatManagementUI::m_bAwaitingRaise
    let awaitTimer = 0;
    let titles = { currentId: 0, ids: [] };
    let titlesSig = "";

    function selectedRec() {
      return selectedKey ? model.find((m) => m.key === selectedKey) ?? null : null;
    }

    function renderHeader() {
      const level = getLevel(stats);
      setAcText(nameEl, stats?.name || "—", { color: C_GOLD, fit: true });
      const tName = titleName(titles.currentId);
      subEl.dataset.empty = tName ? "0" : "1";
      if (tName) setAcText(subEl, tName, { color: C_DIM, fontId: COMPACT_FONT_ID, fit: true });
      const total = getTotalXp(stats);
      setAcText(xpV, stats ? fmt(total) : "—", { color: C_VALUE, fontId: COMPACT_FONT_ID });
      const prog = (stats && xpTables?.levels) ? levelProgress(xpTables.levels, level, total) : null;
      if (prog) {
        meter.dataset.hidden = "0";
        meter.style.setProperty("--hb-ci-fill", `${(prog.fraction * 100).toFixed(1)}%`);
        setAcText(meterV, prog.isMax ? "Max level" : fmt(prog.toNext), { color: "#ffffff", fontId: COMPACT_FONT_ID });
      } else {
        meter.dataset.hidden = "1";
      }
      setAcText(levelV, level ? String(level) : "—", { color: C_NAME, fontId: HEADING_FONT_ID });
    }

    function buildModel() {
      if (activeTab === "attributes") return buildAttributeModel(stats, xpTables);
      if (activeTab === "skills") return buildSkillModel(stats, skillTable, xpTables);
      return buildTitleModel(titles);
    }

    function emptyText() {
      if (!stats && activeTab !== "titles") return "Waiting for character data…";
      if (activeTab === "skills" && !skillTable) return "Loading skills…";
      if (activeTab === "titles") return "You have not earned any titles yet.";
      return "No data.";
    }

    function makeRow(item) {
      if (item.kind === "header") {
        const h = el("div", "hb-ci-group");
        h.dataset.group = item.group;
        h.setAttribute("role", "presentation");
        setAcText(h, item.label, { color: "#ffffff" });
        return h;
      }
      const r = el("div", "hbk-row is-clickable hb-ci-row");
      r.dataset.key = item.key;
      r.dataset.statId = String(item.id);
      r.dataset.statKind = item.kind;
      if (item.kind === "skill") r.dataset.skillId = String(item.id);
      r.setAttribute("role", "option");
      if (item.kind !== "title") {
        const ic = el("span", "hb-ci-icon");
        if (item.icon) ic.style.backgroundImage = `url("${item.icon}")`;
        r.appendChild(ic);
      }
      const n = el("span", "hb-ci-rname");
      const v = el("span", "hb-ci-rval");
      r.append(n, v);
      r._nameEl = n; r._valEl = v;
      r.addEventListener("click", () => select(item.key));
      return r;
    }

    function paintRow(r, item) {
      setAcText(r._nameEl, item.name, { color: item.nameColor ?? C_NAME, fit: true });
      setAcText(r._valEl, item.value ?? "", { color: item.valueColor ?? C_VALUE });
      r.title = item.tip ?? "";
      const sel = item.key === selectedKey;
      r.classList.toggle("is-selected", sel);
      r.setAttribute("aria-selected", sel ? "true" : "false");
    }

    function renderList() {
      model = buildModel();
      if (selectedKey && !model.some((m) => m.key === selectedKey)) selectedKey = null;
      const sig = activeTab + "|" + (model.length ? model.map((m) => m.key).join(",") : `empty:${emptyText()}`);
      if (sig !== renderedKeys) {
        // Structure changed (tab switch, a skill changed section, titles
        // earned) — rebuild. Otherwise the in-place repaint below keeps
        // the canvases (setAcText is idempotent on identical text).
        renderedKeys = sig;
        const keepScroll = list.scrollTop;
        list.replaceChildren();
        rowEls.clear();
        if (!model.length) {
          const e = el("div", "hbk-empty");
          e.textContent = emptyText();
          list.appendChild(e);
        }
        for (const item of model) {
          const r = makeRow(item);
          rowEls.set(item.key, r);
          list.appendChild(r);
        }
        list.scrollTop = keepScroll;
      }
      for (const item of model) {
        if (item.kind === "header") continue;
        const r = rowEls.get(item.key);
        if (r) paintRow(r, item);
      }
    }

    function applyButton(btn, spec, step) {
      const show = !(spec?.hidden);
      btn.dataset.hidden = show ? "0" : "1";
      btn.disabled = !spec?.enabled || awaitingRaise;
      if (!show) { btn.title = ""; return; }
      if (spec.action === "train") btn.title = `Train for ${fmt(spec.cost)} skill credits`;
      else if (spec.cost) {
        const n = spec.ranks || step;
        btn.title = `Raise ${n} rank${n === 1 ? "" : "s"} for ${fmt(spec.cost)} XP`;
      } else btn.title = step === 10 ? "Raise 10 ranks" : "Raise 1 rank";
    }

    function renderFooter() {
      const rec = selectedRec();
      if (activeTab === "titles") {
        btns.dataset.mode = "title";
        raise1.style.display = "none"; raise10.style.display = "none";
        setTitleBtn.style.display = "";
        const pick = rec?.kind === "title" ? rec : null;
        setAcText(footTitle, pick ? pick.name : "Display Title", { color: C_GOLD, fit: true });
        setAcText(l1k, "Current:", { color: C_DIM, fontId: COMPACT_FONT_ID });
        setAcText(l1v, titleName(titles.currentId) || "None", { color: C_VALUE, fontId: COMPACT_FONT_ID });
        setAcText(l2k, "Titles Earned:", { color: C_DIM, fontId: COMPACT_FONT_ID });
        setAcText(l2v, String(titles.ids.length), { color: C_VALUE, fontId: COMPACT_FONT_ID });
        setTitleBtn.disabled = !pick || pick.id === titles.currentId;
        return;
      }
      btns.dataset.mode = "raise";
      raise1.style.display = ""; raise10.style.display = "";
      setTitleBtn.style.display = "none";
      const f = footerModel(activeTab, rec, { availableXp: getAvailableXp(stats), credits: getAvailableCredits() });
      setAcText(footTitle, f.title, { color: C_GOLD, fit: true });
      setAcText(l1k, f.line1[0], { color: C_DIM, fontId: COMPACT_FONT_ID });
      setAcText(l1v, f.line1[1], { color: C_VALUE, fontId: COMPACT_FONT_ID });
      setAcText(l2k, f.line2[0], { color: C_DIM, fontId: COMPACT_FONT_ID });
      setAcText(l2v, f.line2[1], { color: C_VALUE, fontId: COMPACT_FONT_ID });
      applyButton(raise1, f.raise1, 1);
      applyButton(raise10, f.raise10, 10);
      raise1._spec = f.raise1;
      raise10._spec = f.raise10;
    }

    function refreshTitles() {
      titles = readTitleSnapshot();
      const sig = `${titles.currentId}:${titles.ids.join(",")}`;
      const changed = sig !== titlesSig;
      titlesSig = sig;
      return changed;
    }

    function rerender() {
      stats = getStats();
      refreshTitles();
      renderHeader();
      renderList();
      renderFooter();
    }

    function select(key) {
      selectedKey = key;
      for (const item of model) {
        if (item.kind === "header") continue;
        const r = rowEls.get(item.key);
        if (!r) continue;
        const sel = item.key === key;
        r.classList.toggle("is-selected", sel);
        r.setAttribute("aria-selected", sel ? "true" : "false");
      }
      renderFooter();
    }

    function setTab(id) {
      if (!TAB_IDS.has(id)) return;
      activeTab = id;
      lastTab = id;
      selectedKey = null; // ids overlap across tabs (skill 6 vs attribute 6)
      for (const t of TABS) {
        const on = t.id === id;
        tabBtns[t.id].setAttribute("aria-selected", on ? "true" : "false");
        tabBtns[t.id].classList.toggle("is-active", on);
      }
      try { window.__mainPanel?.setTitle?.(tabMeta(id).title); } catch (_) {}
      list.scrollTop = 0;
      rerender();
    }

    function holdForServer() {
      awaitingRaise = true;
      renderFooter();
      clearTimeout(awaitTimer);
      // Fallback release if the server never echoes (lost packet / reject).
      awaitTimer = setTimeout(() => { awaitingRaise = false; if (root.isConnected) renderFooter(); }, 1500);
    }

    async function fire(step) {
      const rec = selectedRec();
      const spec = step === 10 ? raise10._spec : raise1._spec;
      if (!rec || !spec?.enabled || awaitingRaise) return;
      const client = window.__pluginClient;
      const handle = getHandle();
      try {
        if (rec.kind === "skill" && spec.action === "train") {
          const ok = await confirmAction("Train Skill",
            `Train ${rec.name} for ${fmt(spec.cost)} skill credit${spec.cost === 1 ? "" : "s"}?`, "Train");
          if (!ok || !root.isConnected) return;
          const d = decideTrainAction({ kind: "train", skillId: rec.id, cost: spec.cost,
            availableXp: getAvailableXp(stats), availableCredits: getAvailableCredits() }, client);
          if (d.called === "trainSkill") client.player.trainSkill(...d.args);
          else { console.log(`[char-info] train no-op (${d.reason})`); return; }
        } else if (rec.kind === "skill") {
          const d = decideTrainAction({ kind: "raise", skillId: rec.id, cost: spec.cost,
            availableXp: getAvailableXp(stats), availableCredits: getAvailableCredits() }, client);
          if (d.called === "raiseSkill") client.player.raiseSkill(...d.args);
          else { console.log(`[char-info] raise no-op (${d.reason})`); return; }
        } else if (rec.kind === "attribute") {
          handle?.raiseAttribute?.(rec.id >>> 0, spec.cost >>> 0);
        } else if (rec.kind === "vital") {
          handle?.raiseVital?.(rec.id >>> 0, spec.cost >>> 0);
        } else {
          return;
        }
      } catch (e) {
        console.warn(`[char-info] ${spec.action} ${rec.kind} ${rec.id} failed:`, e);
        try {
          window.__pluginClient?.events?.emit?.(rec.kind === "vital" ? "raiseVitalFailed" : "raiseAttributeFailed", {
            detail: { id: rec.id >>> 0, cost: spec.cost >>> 0, error: String(e?.message ?? e) },
          });
        } catch (_) {}
        return;
      }
      holdForServer();
    }
    raise1.addEventListener("click", () => { void fire(1); });
    raise10.addEventListener("click", () => { void fire(10); });

    setTitleBtn.addEventListener("click", () => {
      const rec = selectedRec();
      if (rec?.kind !== "title" || rec.id === titles.currentId) return;
      try {
        const h = getHandle();
        if (typeof h?.setTitle === "function") h.setTitle(rec.id >>> 0);
        else console.warn("[character-info] setTitle wasm export missing");
      } catch (e) { console.warn("[character-info] setTitle failed:", e); }
    });

    // Initial paint, then again as the async tables land.
    setTab(activeTab);
    loadSkillTable().then(() => { if (root.isConnected) rerender(); });
    loadXpTables().then(() => { if (root.isConnected) rerender(); });

    // Live updates — coalesced to one repaint per frame (vital regen
    // fires playerStatsUpdated several times a second).
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      const run = () => {
        raf = 0;
        if (!root.isConnected) return;
        awaitingRaise = false;
        clearTimeout(awaitTimer);
        rerender();
      };
      raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 16);
    };
    const client = window.__pluginClient;
    let off = null;
    if (client?.events?.on) {
      client.events.on("playerStatsUpdated", schedule);
      client.events.on("titleUpdated", schedule);
      off = () => {
        try { client.events.off("playerStatsUpdated", schedule); } catch (_) {}
        try { client.events.off("titleUpdated", schedule); } catch (_) {}
      };
    }

    const instance = { getTab: () => activeTab, setTab };
    activeInstance = instance;

    return () => {
      if (off) off();
      if (raf) { try { cancelAnimationFrame(raf); } catch (_) { clearTimeout(raf); } }
      clearTimeout(awaitTimer);
      if (activeInstance === instance) activeInstance = null;
      root.remove();
    };
  },
};

// Test seam (node): pure model builders.
export const __test = { buildAttributeModel, buildSkillModel, buildTitleModel, resolveTab, titleName };
