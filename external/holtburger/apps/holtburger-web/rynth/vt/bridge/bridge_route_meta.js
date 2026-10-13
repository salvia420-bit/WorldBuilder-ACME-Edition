// rynth/vt/bridge/bridge_route_meta.js — the VT bridge's Route and Meta tabs
// (PLAN W1-10, §3.16; G:185-319) plus the Profiles tab's nav-profile controls
// (critic G3).
//
// Route: ActiveNav (bot.vt.nav) + NavProfiles (bot.vt.navProfiles). The
// insert mode (Add to End / Insert Above / Insert Below, G:210) and the
// selected row are panel state kept here, so `route.add(type, fields)` places
// the waypoint the way VTank does. "Add" uses the world selection (a portal ⇒
// Portal/NPC point; Follow route ⇒ the follow target, G:199).
//
// Meta: MetaEngine (bot.vt.meta) for state/enable/debug/snapshot; rule edits
// are made on a CLONE of engine.meta() and applied with
// engine.replaceMeta(clone, { keepState: true }) — never engine.load(), which
// would re-enter Default and clear the call stack (critic C3). Rule ids are
// the stable "r<n>" form (re-implemented: UI may not import FMT). Files go
// through bot.vt.library only (critic C2).
//
// The keyword tables below are Appendix B (normative numbering and JSON
// fields) with the guide's labels (G:246-292); the panel builds its
// condition/action editors from them.

import { RECALL_SPELL_NAMES } from "../../nav_file.js";
import { safe, ok, fail, command, asResult, clone, isFn, num } from "./bridge_options.js";

// ── Appendix B keyword tables ──────────────────────────────────────────────
// field types: int · float · text · textarea · hex (uint32 shown as hex)

const F = (name, type, label) => Object.freeze({ name, type, label });

export const COND_KEYWORDS = Object.freeze([
  { kw: "Never", met: 0, label: "Never", fields: [] },
  { kw: "Always", met: 1, label: "Always", fields: [] },
  { kw: "All", met: 2, label: "All", fields: [], children: "many" },
  { kw: "Any", met: 3, label: "Any", fields: [], children: "many" },
  { kw: "ChatMatch", met: 4, label: "Chat Message", fields: [F("re", "text", "Regex")] },
  { kw: "MainSlotsLE", met: 5, label: "Pack Slots <=", fields: [F("n", "int", "Slots")] },
  { kw: "SecsInStateGE", met: 6, label: "Seconds in State >=", fields: [F("secs", "int", "Seconds")] },
  { kw: "NavEmpty", met: 7, label: "Navroute Empty", fields: [] },
  { kw: "Death", met: 8, label: "Character Death", fields: [] },
  { kw: "VendorOpen", met: 9, label: "Any Vendor Open", fields: [] },
  { kw: "VendorClosed", met: 10, label: "Vendor Closed", fields: [] },
  { kw: "ItemCountLE", met: 11, label: "Inventory Item Count <=", fields: [F("name", "text", "Item"), F("count", "int", "Count")] },
  { kw: "ItemCountGE", met: 12, label: "Inventory Item Count >=", fields: [F("name", "text", "Item"), F("count", "int", "Count")] },
  {
    kw: "MobsInDist_Name", met: 13, label: "Monster Name Count Within Distance",
    fields: [F("re", "text", "Name regex"), F("dist", "float", "Distance (m)"), F("count", "int", "Count")],
  },
  {
    kw: "MobsInDist_Priority", met: 14, label: "Monster Priority Count Within Distance",
    fields: [F("priority", "int", "Priority"), F("dist", "float", "Distance (m)"), F("count", "int", "Count")],
  },
  { kw: "NeedToBuff", met: 15, label: "Need to Buff", fields: [] },
  { kw: "NoMobsInDist", met: 16, label: "No Monsters Within Distance", fields: [F("dist", "float", "Distance (m)")] },
  { kw: "BlockE", met: 17, label: "Landblock ==", fields: [F("value", "hex", "Landblock (hex)")] },
  { kw: "CellE", met: 18, label: "Landcell ==", fields: [F("value", "hex", "Landcell (hex)")] },
  { kw: "IntoPortal", met: 19, label: "Portalspace Entered", fields: [] },
  { kw: "ExitPortal", met: 20, label: "Portalspace Exited", fields: [] },
  { kw: "Not", met: 21, label: "Not", fields: [], children: "one" },
  { kw: "PSecsInStateGE", met: 22, label: "Seconds in state (P) >=", fields: [F("secs", "int", "Seconds")] },
  { kw: "SecsOnSpellGE", met: 23, label: "Time Left On Spell >=", fields: [F("spellId", "int", "Spell id"), F("secs", "int", "Seconds")] },
  { kw: "BuPercentGE", met: 24, label: "Burden Percent >=", fields: [F("pct", "int", "Percent")] },
  { kw: "DistToRteGE", met: 25, label: "Dist Any Route Pt >=", fields: [F("dist", "float", "Distance (m)")] },
  { kw: "Expr", met: 26, label: "Expression", fields: [F("expr", "text", "Expression")] },
  { kw: "ChatCapture", met: 28, label: "Chat Message Capture", fields: [F("re", "text", "Regex"), F("colors", "text", "Colours (;-separated ids)")] },
].map((k) => Object.freeze({ ...k, fields: Object.freeze(k.fields) })));

export const ACT_KEYWORDS = Object.freeze([
  { kw: "None", met: 0, label: "(none)", fields: [] },
  { kw: "SetState", met: 1, label: "Set Meta State", fields: [F("state", "text", "State")] },
  { kw: "Chat", met: 2, label: "Chat Command", fields: [F("text", "text", "Command / text")] },
  { kw: "DoAll", met: 3, label: "All", fields: [], children: "many" },
  { kw: "EmbedNav", met: 4, label: "Load Embedded Navroute", fields: [F("tag", "text", "Route tag"), F("displayName", "text", "Display name")] },
  { kw: "CallState", met: 5, label: "Call Meta State", fields: [F("state", "text", "Call state"), F("ret", "text", "Return state")] },
  { kw: "Return", met: 6, label: "Return From Call", fields: [] },
  { kw: "DoExpr", met: 7, label: "Expression Action", fields: [F("expr", "text", "Expression")] },
  { kw: "ChatExpr", met: 8, label: "Chat Expression", fields: [F("expr", "text", "Expression")] },
  {
    kw: "SetWatchdog", met: 9, label: "Set Watchdog",
    fields: [F("state", "text", "State"), F("dist", "float", "Distance (m)"), F("secs", "float", "Seconds")],
  },
  { kw: "ClearWatchdog", met: 10, label: "Clear Watchdog", fields: [] },
  { kw: "GetOpt", met: 11, label: "Get VT Option", fields: [F("opt", "text", "Option"), F("var", "text", "Variable")] },
  { kw: "SetOpt", met: 12, label: "Set VT Option", fields: [F("opt", "text", "Option"), F("expr", "text", "Value expression")] },
  { kw: "CreateView", met: 13, label: "Create View", fields: [F("view", "text", "View name"), F("xml", "textarea", "View XML")] },
  { kw: "DestroyView", met: 14, label: "Destroy View", fields: [F("view", "text", "View name")] },
  { kw: "DestroyAllViews", met: 15, label: "Destroy All Views", fields: [] },
].map((k) => Object.freeze({ ...k, fields: Object.freeze(k.fields) })));

const COND_BY_KW = new Map(COND_KEYWORDS.map((k) => [k.kw, k]));
const ACT_BY_KW = new Map(ACT_KEYWORDS.map((k) => [k.kw, k]));

export function condKeyword(kw) {
  return COND_BY_KW.get(kw) || null;
}
export function actKeyword(kw) {
  return ACT_BY_KW.get(kw) || null;
}

const ROUTE_TYPES = Object.freeze([
  { id: 1, name: "Circular" },
  { id: 2, name: "Linear" },
  { id: 3, name: "Follow" },
  { id: 4, name: "Once" },
]);
const INSERT_MODES = Object.freeze(["end", "above", "below"]);
const JUMP_DIRECTIONS = Object.freeze(["forward", "none", "strafeleft", "straferight", "back"]);
const POINT_LABELS = Object.freeze({
  0: "Point", 1: "Portal", 2: "Recall", 3: "Pause", 4: "Chat", 5: "Open Vendor", 6: "Portal/NPC", 7: "NPC Talk", 8: "Checkpoint", 9: "Jump",
});
// Waypoint types whose "Add" picks up the world selection (G:199-202).
const SELECTION_TYPES = new Set([0, 1, 5, 6, 7]);
const RECALL_CACHE_MS = 5000;

// ── descriptions ───────────────────────────────────────────────────────────

const short = (s, n = 60) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const hex8 = (v) => `0x${((Number(v) >>> 0) || 0).toString(16).toUpperCase().padStart(8, "0")}`;

export function describeCond(c, depth = 0) {
  if (!c || typeof c !== "object") return "Never";
  const k = COND_BY_KW.get(c.t);
  if (!k) return `Unsupported: ${c.unknownKeyword || c.t}`;
  const kids = Array.isArray(c.children) ? c.children : [];
  if (k.children) {
    if (depth >= 3) return `${k.label}(…)`;
    return `${k.label}(${kids.map((x) => describeCond(x, depth + 1)).join(k.kw === "Any" ? " | " : ", ")})`;
  }
  switch (c.t) {
    case "ChatMatch":
      return `Chat Message: ${short(c.re)}`;
    case "MainSlotsLE":
      return `Pack Slots <= ${c.n ?? 0}`;
    case "SecsInStateGE":
      return `Seconds in State >= ${c.secs ?? 0}`;
    case "PSecsInStateGE":
      return `Seconds in state (P) >= ${c.secs ?? 0}`;
    case "ItemCountLE":
      return `Item Count <= ${c.count ?? 0} ${c.name ?? ""}`;
    case "ItemCountGE":
      return `Item Count >= ${c.count ?? 0} ${c.name ?? ""}`;
    case "MobsInDist_Name":
      return `${c.count ?? 0}+ "${short(c.re, 30)}" within ${c.dist ?? 0} m`;
    case "MobsInDist_Priority":
      return `${c.count ?? 0}+ priority ${c.priority ?? 0} within ${c.dist ?? 0} m`;
    case "NoMobsInDist":
      return `No Monsters within ${c.dist ?? 0} m`;
    case "BlockE":
      return `Landblock == ${hex8(c.value)}`;
    case "CellE":
      return `Landcell == ${hex8(c.value)}`;
    case "SecsOnSpellGE":
      return `Time Left On Spell ${c.spellId ?? 0} >= ${c.secs ?? 0} s`;
    case "BuPercentGE":
      return `Burden >= ${c.pct ?? 0}%`;
    case "DistToRteGE":
      return `Dist Any Route Pt >= ${c.dist ?? 0} m`;
    case "Expr":
      return `Expression: ${short(c.expr)}`;
    case "ChatCapture":
      return `Chat Capture: ${short(c.re)}`;
    default:
      return k.label;
  }
}

export function describeAct(a, depth = 0) {
  if (!a || typeof a !== "object") return "(none)";
  const k = ACT_BY_KW.get(a.t);
  if (!k) return `Unsupported: ${a.unknownKeyword || a.t}`;
  if (k.children) {
    const kids = Array.isArray(a.children) ? a.children : [];
    if (depth >= 3) return "All(…)";
    return `All(${kids.map((x) => describeAct(x, depth + 1)).join("; ")})`;
  }
  switch (a.t) {
    case "SetState":
      return `Set Meta State: ${a.state ?? ""}`;
    case "Chat":
      return `Chat: ${short(a.text)}`;
    case "EmbedNav":
      return `Load Embedded Navroute: ${a.displayName || a.tag || ""}`;
    case "CallState":
      return `Call Meta State: ${a.state ?? ""}${a.ret ? ` (return ${a.ret})` : ""}`;
    case "DoExpr":
      return `Expression: ${short(a.expr)}`;
    case "ChatExpr":
      return `Chat Expression: ${short(a.expr)}`;
    case "SetWatchdog":
      return `Set Watchdog: ${a.state ?? ""} ${a.dist ?? 0} m / ${a.secs ?? 0} s`;
    case "GetOpt":
      return `Get VT Option ${a.opt ?? ""} → ${a.var ?? ""}`;
    case "SetOpt":
      return `Set VT Option ${a.opt ?? ""} = ${short(a.expr, 40)}`;
    case "CreateView":
      return `Create View: ${a.view ?? ""}`;
    case "DestroyView":
      return `Destroy View: ${a.view ?? ""}`;
    default:
      return k.label;
  }
}

function coordText(ns, ew) {
  const n = Number(ns);
  const e = Number(ew);
  if (!Number.isFinite(n) || !Number.isFinite(e)) return "";
  return `${Math.abs(n).toFixed(2)}${n >= 0 ? "N" : "S"}, ${Math.abs(e).toFixed(2)}${e >= 0 ? "E" : "W"}`;
}

export function describePoint(p, spellName = (id) => RECALL_SPELL_NAMES[id] || `spell ${id}`) {
  if (!p || typeof p !== "object") return "?";
  const t = Number(p.type);
  const at = coordText(p.ns, p.ew);
  switch (t) {
    case 0:
      return `Point ${at}`;
    case 1:
      return `Portal 0x${((Number(p.guid) >>> 0) || 0).toString(16)} ${at}`;
    case 2:
      return `Recall: ${spellName(Number(p.spellId) >>> 0)}`;
    case 3:
      return `Pause ${Math.round((Number(p.pauseMs) || 0) / 100) / 10} s`;
    case 4:
      return `Chat: ${short(p.chat, 50)}`;
    case 5:
      return `Open Vendor: ${p.name || `0x${((Number(p.vendorId) >>> 0) || 0).toString(16)}`}`;
    case 6:
      return `Portal/NPC: ${p.name || "?"}`;
    case 7:
      return `NPC Talk: ${p.name || "?"}`;
    case 8:
      return `Checkpoint ${at}`;
    case 9: {
      const dir = p.ext && p.ext.direction ? ` ${p.ext.direction}` : "";
      return `Jump ${Math.round(Number(p.headingDeg) || 0)}°${p.holdShift ? " shift" : ""} ${Math.round(Number(p.delayMs) || 0)} ms${dir}`;
    }
    default:
      return POINT_LABELS[t] || `type ${t}`;
  }
}

/**
 * Next stable rule id "r<n>" = formats/meta_schema.js newRuleId (re-implemented,
 * C2): n = 1 + the highest numeric suffix in use, so a deleted rule's id is
 * never handed to a new rule (META keys fired flags and lastFired by id).
 * `existing`: a Set / array of ids, or an array of rules.
 */
export function newRuleId(existing) {
  const ids = [];
  if (existing instanceof Set) ids.push(...existing);
  else if (Array.isArray(existing)) for (const e of existing) ids.push(e && typeof e === "object" ? e.id : e);
  const used = new Set();
  let max = 0;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    used.add(id);
    const m = /^r(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  while (used.has(`r${n}`)) n++;
  return `r${n}`;
}

function emptyMeta() {
  return { v: 1, name: "", source: { kind: "json" }, rules: [], navs: {}, warnings: [] };
}

const MAX_NODE_DEPTH = 64;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * One condition/action node → every Appendix-B field present and typed as
 * formats/meta_schema.js validateMeta requires (text → string; int → Int32;
 * float → finite number; hex → uint32); compound nodes get a `children`
 * array (recursively cleaned), the others none. Unknown keywords (a loaded
 * file's inert nodes) are kept as they are.
 */
function cleanNode(kind, node, depth = 0) {
  const table = kind === "cond" ? COND_BY_KW : ACT_BY_KW;
  if (!node || typeof node !== "object" || typeof node.t !== "string") return kind === "cond" ? { t: "Never" } : { t: "None" };
  const k = table.get(node.t);
  if (!k || node.unknownKeyword !== undefined || depth > MAX_NODE_DEPTH) return node;
  const out = { ...node };
  for (const f of k.fields) {
    const v = out[f.name];
    if (f.type === "text" || f.type === "textarea") {
      out[f.name] = typeof v === "string" ? v : v == null ? "" : String(v);
      continue;
    }
    let n = typeof v === "string" && f.type === "hex" ? parseInt(v.trim().replace(/^0x/i, ""), 16) : Number(v);
    if (!Number.isFinite(n)) n = 0;
    if (f.type === "hex") n = Math.trunc(n) >>> 0;
    else if (f.type === "int") n = Math.max(INT32_MIN, Math.min(INT32_MAX, Math.trunc(n)));
    out[f.name] = n;
  }
  if (k.children) out.children = (Array.isArray(out.children) ? out.children : []).map((c) => cleanNode(kind, c, depth + 1));
  else delete out.children;
  return out;
}

/** The first structural problem validateMeta would report for an edited rule, or null. */
function nodeProblem(kind, node, navs, depth = 0) {
  if (!node || typeof node !== "object" || depth > MAX_NODE_DEPTH) return null;
  if (kind === "cond" && node.t === "Not" && node.unknownKeyword === undefined && (!Array.isArray(node.children) || node.children.length !== 1)) {
    return "Not needs exactly one condition";
  }
  if (kind === "act" && node.t === "EmbedNav" && node.unknownKeyword === undefined) {
    const tag = String(node.tag ?? "").trim();
    const keys = navs && typeof navs === "object" ? Object.keys(navs) : [];
    if (!tag) return "Load Embedded Navroute needs a route tag";
    if (!keys.some((x) => x.toLowerCase() === tag.toLowerCase())) {
      return `this meta has no embedded route "${tag}"${keys.length ? ` (routes: ${keys.join(", ")})` : ""}`;
    }
  }
  for (const c of Array.isArray(node.children) ? node.children : []) {
    const p = nodeProblem(kind, c, navs, depth + 1);
    if (p) return p;
  }
  return null;
}

/** A rule from the editor → the §3.2 Rule shape (id assigned by the caller). */
function cleanRule(rule) {
  const r = rule && typeof rule === "object" ? clone(rule) : {};
  const state = String(r.state ?? "").trim() || "Default";
  const cond = cleanNode("cond", r.cond && typeof r.cond === "object" && typeof r.cond.t === "string" ? r.cond : { t: "Always" });
  const act = cleanNode("act", r.act && typeof r.act === "object" && typeof r.act.t === "string" ? r.act : { t: "None" });
  return { ...r, state, enabled: r.enabled !== false, cond, act };
}

/**
 * cleanRule + the structural checks → { rule } | { error }. `check` names the
 * parts the editor changed (an enable toggle never re-validates a rule as it
 * was loaded from a file).
 */
function editedRule(rule, navs, check = { cond: true, act: true }) {
  const r = cleanRule(rule);
  const p = (check.cond && nodeProblem("cond", r.cond, navs)) || (check.act && nodeProblem("act", r.act, navs));
  return p ? { error: p } : { rule: r };
}

// ── factory ────────────────────────────────────────────────────────────────

/** ctx = { win, now, getBot, layerOf(bot), optionsOf(vt), hostOf(bot) } */
export function createRouteMetaBridge(ctx) {
  const ui = { insertMode: "end", selected: null };
  let recallCache = { at: -Infinity, host: null, list: [] };

  const cur = () => {
    const bot = ctx.getBot();
    const vt = ctx.layerOf(bot);
    return { bot, vt, options: ctx.optionsOf(vt), host: ctx.hostOf(bot) };
  };
  const navOf = (vt) => (vt ? safe(() => vt.nav ?? null) : null);
  const profilesOf = (vt) => (vt ? safe(() => vt.navProfiles ?? null) : null);
  const engineOf = (vt) => (vt ? safe(() => vt.meta ?? null) : null);
  const libraryOf = (vt) => (vt ? safe(() => vt.library ?? null) : null);
  const viewsOf = (vt) => (vt ? safe(() => vt.views ?? null) : null);

  function knownRecalls(host) {
    const now = ctx.now();
    if (recallCache.host === host && now - recallCache.at < RECALL_CACHE_MS) return recallCache.list;
    let known = safe(() => host?.TryGetKnownSpells?.(), null);
    if (!Array.isArray(known) || !known.length) known = safe(() => Array.from(ctx.win?.__sessionHandle?.playerKnownSpells?.() || []), []) || [];
    const set = new Set(known.map((x) => Number(x) >>> 0));
    const list = Object.entries(RECALL_SPELL_NAMES)
      .map(([id, name]) => ({ id: Number(id), name: String(name), known: set.has(Number(id)) }))
      .filter((r) => r.known)
      .sort((a, b) => a.name.localeCompare(b.name));
    recallCache = { at: now, host, list };
    return list;
  }

  function statusLine(st) {
    if (!st) return "No route";
    const n = Number(st.n) || 0;
    const i = Number(st.i) || 0;
    const kind = st.typeName || (ROUTE_TYPES.find((t) => t.id === st.type)?.name ?? "").toLowerCase();
    const parts = [];
    if (st.type === 3) {
      const ft = st.followTarget;
      parts.push(`Nav: follow ${ft ? ft.name || `0x${(Number(ft.guid) >>> 0).toString(16)}` : "(no target)"}`);
    } else {
      parts.push(`Nav: ${n ? i + 1 : 0}/${n} ${kind}${st.reversed ? " (reversed)" : ""}`);
    }
    parts.push(st.exec ? String(st.exec) : st.enabled ? "idle" : "navigation off");
    if (st.blockedBy && st.blockedBy !== "disabled") parts.push(String(st.blockedBy));
    if (st.lastResult) parts.push(`last: ${st.lastResult}`);
    return parts.join(" · ");
  }

  // ── view-models ──────────────────────────────────────────────────────────
  function routeView(vt, bot) {
    const nav = navOf(vt);
    const host = ctx.hostOf(bot);
    const profiles = profilesOf(vt);
    const options = ctx.optionsOf(vt);
    const st = nav && isFn(nav.status) ? safe(() => nav.status(), null) : null;
    const route = nav && isFn(nav.route) ? safe(() => nav.route(), null) : null;
    const points = route && Array.isArray(route.points) ? route.points : [];
    const active = route ? Number(route.activeIndex) || 0 : 0;
    if (ui.selected != null && (ui.selected < 0 || ui.selected >= points.length)) ui.selected = null;
    const nameOf = (id) => {
      const rec = safe(() => host?.TryGetSpellRecord?.(id), null);
      return (rec && rec.name) || RECALL_SPELL_NAMES[id] || `spell ${id}`;
    };
    return {
      available: !!nav,
      status: st,
      statusLine: nav ? statusLine(st) : "Start the bot to edit routes.",
      routeType: route ? Number(route.routeType) || 1 : 1,
      activeIndex: active,
      reversed: !!(route && route.reversed),
      enabled: !!(st && st.enabled),
      paused: st && st.paused ? st.paused : null,
      followTarget: route && route.followTarget ? { ...route.followTarget } : null,
      points: points.map((p, i) => ({
        index: i,
        type: Number(p.type),
        typeLabel: POINT_LABELS[Number(p.type)] || String(p.type),
        label: describePoint(p, nameOf),
        active: i === active,
        selected: i === ui.selected,
        pauseMs: num(p.pauseMs),
        chat: typeof p.chat === "string" ? p.chat : null,
      })),
      insertMode: ui.insertMode,
      selected: ui.selected,
      types: ROUTE_TYPES.map((t) => ({ ...t })),
      insertModes: INSERT_MODES.slice(),
      directions: JUMP_DIRECTIONS.slice(),
      profiles: profiles && isFn(profiles.list) ? (safe(() => profiles.list(), []) || []).map((p) => ({ name: String(p.name ?? ""), savedAt: num(p.savedAt) })) : [],
      currentProfile: safe(() => options?.getRef?.("navProfile"), null),
      recalls: nav ? knownRecalls(host) : [],
    };
  }

  function navProfilesView(vt) {
    const profiles = profilesOf(vt);
    const options = ctx.optionsOf(vt);
    return {
      available: !!(profiles && navOf(vt)),
      profiles: profiles && isFn(profiles.list) ? (safe(() => profiles.list(), []) || []).map((p) => ({ name: String(p.name ?? "") })) : [],
      current: safe(() => options?.getRef?.("navProfile"), null),
    };
  }

  function metaView(vt) {
    const engine = engineOf(vt);
    const lib = libraryOf(vt);
    const views = viewsOf(vt);
    const options = ctx.optionsOf(vt);
    const snap = engine && isFn(engine.snapshot) ? safe(() => engine.snapshot(), null) : null;
    const meta = engine && isFn(engine.meta) ? safe(() => engine.meta(), null) : null;
    const fired = new Set(snap && Array.isArray(snap.fired) ? snap.fired : []);
    const curState = snap ? String(snap.state ?? "Default") : "Default";
    const groups = [];
    const at = new Map();
    const rules = meta && Array.isArray(meta.rules) ? meta.rules : [];
    rules.forEach((r, i) => {
      const st = String(r.state ?? "Default");
      const k = st.toLowerCase();
      if (!at.has(k)) {
        at.set(k, { state: st, current: k === curState.toLowerCase(), rules: [] });
        groups.push(at.get(k));
      }
      at.get(k).rules.push({
        id: String(r.id),
        order: i,
        state: st,
        enabled: r.enabled !== false,
        fired: fired.has(String(r.id)),
        condText: describeCond(r.cond),
        actText: describeAct(r.act),
        cond: clone(r.cond),
        act: clone(r.act),
      });
    });
    const enabled = snap ? !!snap.enabled : !!safe(() => options?.getValue?.("EnableMeta"), false);
    return {
      available: !!engine,
      enabled,
      debug: !!(snap && snap.debug),
      snapshot: snap,
      state: curState,
      states: snap && Array.isArray(snap.states) ? snap.states.slice() : ["Default"],
      name: snap ? snap.name ?? null : null,
      loaded: !!meta,
      ruleCount: rules.length,
      groups,
      embeddedNavKeys: meta && meta.navs && typeof meta.navs === "object" ? Object.keys(meta.navs) : [],
      library: lib && isFn(lib.listMetas) ? (safe(() => lib.listMetas(), []) || []).map((m) => ({ name: String(m.name ?? ""), savedAt: num(m.savedAt), bytes: num(m.bytes) })) : [],
      libraryAvailable: !!(lib && isFn(lib.listMetas)),
      views: views && isFn(views.list) ? safe(() => views.list(), []) || [] : [],
      condKeywords: COND_KEYWORDS,
      actKeywords: ACT_KEYWORDS,
    };
  }

  // ── commands: route ──────────────────────────────────────────────────────
  const needNav = () => {
    const c = cur();
    const nav = navOf(c.vt);
    if (!nav) throw new Error("start the bot to edit routes");
    return { ...c, nav, profiles: profilesOf(c.vt) };
  };
  const navCall = (nav, name, ...args) => {
    if (!isFn(nav[name])) return fail(`navigation has no ${name}`);
    return asResult(nav[name](...args));
  };

  function selectionFields(type, fields, host) {
    const f = fields && typeof fields === "object" ? { ...fields } : {};
    const t = Number(type);
    // A typed vendor name wins over whatever happens to be selected (G:200 "selected/named").
    const named = t === 5 && typeof f.name === "string" && f.name.trim() !== "";
    if (SELECTION_TYPES.has(t) && !named && f.targetGuid == null && f.guid == null) {
      const g = (Number(safe(() => (isFn(host?.GetSelectedId) ? host.GetSelectedId() : 0), 0)) >>> 0)
        || (Number(safe(() => ctx.win?.liveScene3d?.entityManager?.getSelectedTarget?.(), 0)) >>> 0);
      if (g) f.targetGuid = g;
    }
    return f;
  }

  const route = {
    status: command(() => {
      const { nav } = needNav();
      const st = safe(() => nav.status(), null);
      return ok({ status: st, statusLine: statusLine(st) });
    }),
    list: command(() => {
      const { profiles } = needNav();
      return ok({ profiles: profiles && isFn(profiles.list) ? profiles.list() : [] });
    }),
    load: command((name) => navCall(needNav().nav, "loadByName", String(name ?? "").trim())),
    save: command((name) => navCall(needNav().nav, "save", String(name ?? "").trim())),
    remove: command((name) => {
      const { profiles } = needNav();
      if (!profiles || !isFn(profiles.remove)) return fail("no nav profile store");
      return asResult(profiles.remove(String(name ?? "").trim()));
    }),
    clear: command(() => {
      ui.selected = null;
      return navCall(needNav().nav, "clear");
    }),
    setType: command((t) => navCall(needNav().nav, "setType", t)),
    setInsertMode: command((m) => {
      const mode = String(m ?? "").toLowerCase();
      if (!INSERT_MODES.includes(mode)) return fail(`insert mode must be one of ${INSERT_MODES.join(", ")}`);
      ui.insertMode = mode;
      return ok({ insertMode: mode });
    }),
    select: command((i) => {
      ui.selected = i == null || i === "" || Number(i) < 0 ? null : Math.trunc(Number(i));
      return ok({ selected: ui.selected });
    }),
    add: command((type, fields = {}, mode = null) => {
      const { nav, host } = needNav();
      if (!isFn(nav.addHere)) return fail("navigation has no addHere");
      const m = mode == null ? ui.insertMode : String(mode).toLowerCase();
      if (!INSERT_MODES.includes(m)) return fail(`insert mode must be one of ${INSERT_MODES.join(", ")}`);
      const sel = m === "end" ? null : ui.selected;
      const r = asResult(nav.addHere(Number(type), selectionFields(type, fields, host), { mode: m, selected: sel }));
      // Keep repeated inserts in reading order: "above" stays on the original
      // row (now one lower), "below" follows the new row.
      if (r.ok && Number.isInteger(r.index) && m !== "end") ui.selected = m === "above" ? r.index + 1 : r.index;
      return r;
    }),
    updatePoint: command((i, patch) => navCall(needNav().nav, "updatePoint", Math.trunc(Number(i)), patch || {})),
    setActive: command((i) => navCall(needNav().nav, "setActive", Math.trunc(Number(i)))),
    step: command((d) => navCall(needNav().nav, "step", Math.trunc(Number(d)) || 0)),
    removeAt: command((i) => {
      const idx = Math.trunc(Number(i));
      const r = navCall(needNav().nav, "removeAt", idx);
      if (r.ok && ui.selected != null) {
        if (ui.selected === idx) ui.selected = null;
        else if (ui.selected > idx) ui.selected -= 1;
      }
      return r;
    }),
    reverse: command((flag) => {
      const { nav } = needNav();
      if (!isFn(nav.reverse)) return fail("navigation has no reverse");
      const v = nav.reverse(flag === undefined ? undefined : flag === true || flag === "true");
      return ok({ reversed: !!v });
    }),
    enable: command((on) => {
      const { nav } = needNav();
      const r = isFn(nav.setEnabled) ? nav.setEnabled(!!on) : ((nav.enabled = !!on), { ok: true });
      if (r && r.ok === false) return asResult(r);
      if (on && isFn(nav.resume)) safe(() => nav.resume());
      return ok({ enabled: !!on });
    }),
    importText: command((name, text) => {
      const { profiles } = needNav();
      if (!profiles || !isFn(profiles.importText)) return fail("no nav profile store");
      return asResult(profiles.importText(String(name ?? "").trim(), String(text ?? "")));
    }),
    exportText: command((name) => {
      const { profiles } = needNav();
      if (!profiles || !isFn(profiles.exportText)) return fail("no nav profile store");
      return asResult(profiles.exportText(String(name ?? "").trim()));
    }),
  };

  const navProfiles = {
    list: command(() => ok(navProfilesView(cur().vt))),
    select: command((name) => navCall(needNav().nav, "loadByName", String(name ?? "").trim())),
    saveAs: command((name) => navCall(needNav().nav, "save", String(name ?? "").trim())),
  };

  // ── commands: meta ───────────────────────────────────────────────────────
  const needEngine = () => {
    const c = cur();
    const engine = engineOf(c.vt);
    if (!engine) throw new Error("start the bot to use metas");
    return { ...c, engine };
  };
  const needLib = () => {
    const c = cur();
    const lib = libraryOf(c.vt);
    if (!lib) throw new Error("the meta library needs the bot (start it first)");
    return { ...c, lib };
  };
  const libCall = (lib, name, ...args) => {
    if (!isFn(lib[name])) return fail(`the library has no ${name}`);
    return asResult(lib[name](...args));
  };

  /** Clone engine.meta(), mutate, apply with replaceMeta(keepState). Never load(). */
  function editMeta(mutate) {
    const { engine } = needEngine();
    if (!isFn(engine.replaceMeta)) return fail("this meta engine cannot be edited live");
    const base = isFn(engine.meta) ? safe(() => engine.meta(), null) : null;
    const draft = base ? clone(base) : emptyMeta();
    if (!Array.isArray(draft.rules)) draft.rules = [];
    const res = mutate(draft);
    if (res && res.ok === false) return res;
    const r = engine.replaceMeta(draft, { keepState: true });
    if (r && r.ok === false) return asResult(r);
    return ok({ ...(res && typeof res === "object" ? res : {}), warnings: (r && r.warnings) || [] });
  }
  const findRule = (draft, id) => draft.rules.findIndex((r) => r && String(r.id) === String(id));

  const meta = {
    status: command(() => {
      const { engine } = needEngine();
      return ok({ snapshot: isFn(engine.snapshot) ? engine.snapshot() : null });
    }),
    list: command(() => {
      const { lib } = needLib();
      return ok({ metas: isFn(lib.listMetas) ? lib.listMetas() : [] });
    }),
    load: command((name) => libCall(needLib().lib, "loadMeta", String(name ?? "").trim())),
    importFile: command((name, bytesOrText, kind) => {
      const k = String(kind ?? "").toLowerCase();
      if (!["met", "af", "json"].includes(k)) return fail("meta files are .met, .af or .json");
      return libCall(needLib().lib, "importMeta", String(name ?? "").trim(), bytesOrText, k);
    }),
    exportFile: command((name, kind) => {
      const k = String(kind ?? "").toLowerCase();
      if (!["met", "af", "json"].includes(k)) return fail("export as .met, .af or .json");
      return libCall(needLib().lib, "exportMeta", String(name ?? "").trim(), k);
    }),
    save: command((name) => {
      const { lib, vt } = needLib();
      const engine = engineOf(vt);
      const m = engine && isFn(engine.meta) ? engine.meta() : null;
      if (!m) return fail("no meta loaded — add rules or load one first");
      return libCall(lib, "saveMeta", String(name ?? "").trim(), clone(m));
    }),
    setEnabled: command((on) => {
      const c = cur();
      const engine = engineOf(c.vt);
      if (engine) {
        engine.enabled = !!on;
        return ok({ enabled: !!on });
      }
      if (!c.options) return fail("no VTank settings yet");
      return asResult(c.options.set("EnableMeta", !!on, { source: "ui" }));
    }),
    setDebug: command((on) => {
      const { engine } = needEngine();
      if (!isFn(engine.setDebug)) return fail("this meta engine has no debug mode");
      engine.setDebug(!!on);
      return ok({ debug: !!on });
    }),
    setState: command((s) => {
      const { engine } = needEngine();
      const st = String(s ?? "").trim();
      if (!st) return fail("pick a state");
      const r = engine.enterState(st, "manual");
      return r === false ? fail(`cannot enter state "${st}"`) : ok({ state: st });
    }),
    addRule: command((rule) =>
      editMeta((draft) => {
        const ids = new Set(draft.rules.map((r) => String(r && r.id)));
        const e = editedRule(rule, draft.navs);
        if (e.error) return fail(e.error);
        const r = e.rule;
        r.id = newRuleId(ids);
        draft.rules.push(r);
        return { id: r.id };
      }),
    ),
    updateRule: command((id, patch) =>
      editMeta((draft) => {
        const i = findRule(draft, id);
        if (i < 0) return fail(`no rule ${id}`);
        const p = patch && typeof patch === "object" ? clone(patch) : {};
        delete p.id;
        const e = editedRule({ ...draft.rules[i], ...p }, draft.navs, { cond: "cond" in p, act: "act" in p });
        if (e.error) return fail(e.error);
        draft.rules[i] = { ...e.rule, id: draft.rules[i].id };
        return { id: draft.rules[i].id };
      }),
    ),
    deleteRule: command((id) =>
      editMeta((draft) => {
        const i = findRule(draft, id);
        if (i < 0) return fail(`no rule ${id}`);
        draft.rules.splice(i, 1);
        return { id: String(id) };
      }),
    ),
    moveRule: command((id, delta) =>
      editMeta((draft) => {
        const i = findRule(draft, id);
        if (i < 0) return fail(`no rule ${id}`);
        const d = Math.sign(Number(delta) || 0);
        if (!d) return { id: String(id) };
        // Order matters only among one state's rules: swap with the nearest
        // rule of the same state in that direction.
        const st = String(draft.rules[i].state ?? "").toLowerCase();
        let j = i + d;
        while (j >= 0 && j < draft.rules.length && String(draft.rules[j].state ?? "").toLowerCase() !== st) j += d;
        if (j < 0 || j >= draft.rules.length) return { id: String(id), unchanged: true };
        const tmp = draft.rules[i];
        draft.rules[i] = draft.rules[j];
        draft.rules[j] = tmp;
        return { id: String(id) };
      }),
    ),
    /** Additive: copy a rule (new id) right below it. */
    duplicateRule: command((id) =>
      editMeta((draft) => {
        const i = findRule(draft, id);
        if (i < 0) return fail(`no rule ${id}`);
        const ids = new Set(draft.rules.map((r) => String(r && r.id)));
        const copy = { ...clone(draft.rules[i]), id: newRuleId(ids) };
        draft.rules.splice(i + 1, 0, copy);
        return { id: copy.id };
      }),
    ),
    /** Additive: a meta view's control was clicked (meta_views.js renderer). */
    clickView: command((view, ctrl) => {
      const views = viewsOf(cur().vt);
      if (!views || !isFn(views.click)) return fail("no meta views");
      return asResult(views.click(view, ctrl));
    }),
  };

  /**
   * Attach a DOM renderer to the current layer's ViewManager when it has
   * none yet (the panel calls this on open and on each refresh; a new layer
   * after a rebind gets it again). → true when attached now.
   */
  function ensureViewRenderer(factory) {
    const views = viewsOf(cur().vt);
    if (!views || !isFn(views.setRenderer) || !isFn(factory)) return false;
    if (views.renderer) return false;
    const r = safe(() => factory(), null);
    if (!r) return false;
    safe(() => views.setRenderer(r));
    return true;
  }

  /**
   * Detach `renderer` from the current ViewManager when it is still the one
   * attached (panel dispose: its windows go with the panel; the views stay in
   * the meta and are drawn again by the next renderer). → true when detached.
   */
  function releaseViewRenderer(renderer) {
    const views = viewsOf(cur().vt);
    if (!renderer || !views || !isFn(views.setRenderer) || views.renderer !== renderer) return false;
    safe(() => views.setRenderer(null));
    return true;
  }

  return {
    route,
    navProfiles,
    meta,
    ensureViewRenderer,
    releaseViewRenderer,
    views: { route: routeView, navProfiles: navProfilesView, meta: metaView },
  };
}
