// rynth/vt/bridge/bridge_options.js — the VT bridge's settings side (PLAN
// W1-10, §3.16; G:1-58).
//
// Options tab (G:1-42), its "Advanced…" sub-view (every SCHEMA row, grouped,
// typed, inert rows flagged), the Vitals tab (G:60-66) and the Profiles tab
// (G:44-58): pure view-models over VtOptions + the commands the panel drives.
// Everything here works WITHOUT a bot (the page session's VtOptions), which is
// how a player edits a profile before pressing START.
//
// This file also hosts the bridge's tiny shared helpers (safe / ok / fail /
// command), imported by the other bridge files — the package has no util
// module and C2 keeps them in-package.
//
// Discipline (rynth/hud_bridge.js): nothing throws, every command resolves to
// { ok, error?, … }, every read of a service is guarded (fakes and older
// layers lack members).

// ── shared helpers ─────────────────────────────────────────────────────────

/** fn() or dflt when it throws / returns undefined. */
export function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

export function errText(e) {
  if (e == null) return "failed";
  if (typeof e === "string") return e || "failed";
  return String(e.message || e) || "failed";
}

export const ok = (extra = {}) => ({ ok: true, ...extra });
export const fail = (error, extra = {}) => ({ ok: false, error: errText(error), ...extra });

/** A service result → the bridge's { ok, … } shape. */
export function asResult(r, okExtra = null) {
  if (r && typeof r === "object" && typeof r.ok === "boolean") {
    if (!r.ok) return { ...r, error: errText(r.error || "refused") };
    return okExtra ? { ...r, ...okExtra } : r;
  }
  return ok(okExtra ? { value: r, ...okExtra } : { value: r });
}

/** Wrap a command: ALWAYS a Promise, never a rejection, never a throw. */
export function command(fn) {
  return (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .then((r) => asResult(r), (e) => fail(e));
}

export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const isFn = (f) => typeof f === "function";

/** JSON-ish deep copy for plain data (lists, rules, entries). */
export function clone(v) {
  if (v === null || v === undefined || typeof v !== "object") return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return Array.isArray(v) ? v.slice() : { ...v };
  }
}

// ── schema rows → editor rows ──────────────────────────────────────────────

const PAGE_ORDER = ["options", "profiles", "vitals", "meta", "route", "advanced"];
const UNIT_TEXT = Object.freeze({ m: "m", pct: "%", s: "s", ms: "ms", count: "", power: "0-1" });

/** A schema row (VtOptions.list() item) → the panel's typed-editor row. */
export function rowView(item) {
  const row = item && item.row ? item.row : item || {};
  const value = item && "value" in item ? item.value : row.dflt;
  const out = {
    key: String(row.key ?? item?.key ?? ""),
    label: String(row.label ?? row.key ?? ""),
    vtName: String(item?.vtName ?? (Array.isArray(row.vt) && row.vt[0]) ?? row.key ?? ""),
    vtNames: Array.isArray(row.vt) ? row.vt.slice() : [],
    type: row.type || "string",
    unit: row.unit ?? null,
    unitText: row.unit ? UNIT_TEXT[row.unit] ?? row.unit : "",
    lbf: row.vtUnit === "lbf",
    value: clone(value),
    dflt: clone(row.dflt),
    min: num(row.min),
    max: num(row.max),
    values: Array.isArray(row.values) ? row.values.slice() : null,
    inert: row.consumer === "inert" || item?.inert === true,
    web: !Array.isArray(row.vt) || row.vt.length === 0,
    help: row.help ? String(row.help) : "",
    page: String(row.page ?? ""),
    group: String(row.group ?? ""),
    isDefault: sameValue(value, row.dflt),
  };
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** All rows of the session/layer options (one VtOptions.list() call). */
export function allRows(options) {
  const list = safe(() => options?.list?.(), null);
  return Array.isArray(list) ? list.map(rowView) : [];
}

/** Rows grouped by `group`, groups in first-appearance order. */
export function groupRows(rows) {
  const groups = [];
  const at = new Map();
  for (const r of rows) {
    const g = r.group || "Other";
    if (!at.has(g)) {
      at.set(g, { group: g, rows: [] });
      groups.push(at.get(g));
    }
    at.get(g).rows.push(r);
  }
  return groups;
}

// ── run state (Run Macro, G:7) ─────────────────────────────────────────────

/** Cheap run-state read: no wasm, no OperatorControl.state() recompute. */
export function runState(bot) {
  if (!bot) return { phase: "no-bot", running: false, held: false };
  const held = safe(() => bot.kernel?.operatorHeld === true, false);
  return { phase: held ? "stopped" : "running", running: !held, held };
}

export function forceRebuffState(bot) {
  const buff = safe(() => bot?.buff ?? null);
  return {
    available: !!(buff && isFn(buff.forceRebuff)),
    cancellable: !!(buff && isFn(buff.cancelForceRebuff)),
    active: !!safe(() => (typeof buff?.forceRebuffing === "boolean" ? buff.forceRebuffing : buff?._forceRebuffing === true), false),
  };
}

// ── view-models ────────────────────────────────────────────────────────────

/** Active profile summary (every tab shows the Default read-only banner). */
export function profileSummary(options) {
  const a = safe(() => options?.profiles?.active?.(), null);
  if (!a) return null;
  const kind = String(a.kind ?? "default");
  return {
    name: String(a.name ?? "Default"),
    kind,
    writable: a.writable !== false && kind !== "default",
    label: kind === "char" ? `[Char] ${a.name}` : String(a.name ?? "Default"),
    readOnly: kind === "default",
  };
}

/** Options tab (G:1-42): page "options" rows by group + run/force-buff state. */
export function optionsTabView(options, bot) {
  const rows = allRows(options);
  return {
    groups: groupRows(rows.filter((r) => r.page === "options")),
    run: runState(bot),
    forceRebuff: forceRebuffState(bot),
  };
}

/** The "Advanced…" sub-view: EVERY schema row, grouped, filterable. */
export function advancedTabView(options, filter = "") {
  const f = String(filter ?? "").trim().toLowerCase();
  let rows = allRows(options);
  if (f) {
    rows = rows.filter((r) =>
      [r.key, r.label, r.group, r.page, ...r.vtNames].some((s) => String(s).toLowerCase().includes(f)),
    );
  }
  const order = (r) => {
    const i = PAGE_ORDER.indexOf(r.page);
    return i < 0 ? PAGE_ORDER.length : i;
  };
  const sorted = rows.map((r, i) => [r, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map((x) => x[0]);
  // "Not on web" (inert) last, whatever page it sits on.
  const live = sorted.filter((r) => !r.inert);
  const inert = sorted.filter((r) => r.inert);
  return { filter: f, groups: groupRows([...live, ...inert]), count: rows.length };
}

// Vitals tab (G:60-66): the six VTank fields + the three web extras.
const VITALS_LAYOUT = Object.freeze([
  { title: "Top-off levels (no combat target)", keys: ["TopOffHP", "TopOffStam", "TopOffMana"] },
  { title: "In combat (recharge at)", keys: ["HealAt", "RestamAt", "GetManaAt"] },
  { title: "Web extras", keys: ["EmergencyHP", "EmergencyStamFloor", "ManaRechargeStamFloor"] },
]);

export function vitalsTabView(options) {
  const rows = allRows(options).filter((r) => r.page === "vitals");
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const used = new Set();
  const groups = [];
  for (const g of VITALS_LAYOUT) {
    const list = g.keys.map((k) => byKey.get(k)).filter(Boolean);
    for (const r of list) used.add(r.key);
    if (list.length) groups.push({ group: g.title, rows: list });
  }
  const rest = rows.filter((r) => !used.has(r.key));
  if (rest.length) groups.push({ group: "Other", rows: rest });
  return { groups };
}

const PROFILE_KEYS = Object.freeze(["EnableNavigation", "EnableLooting", "ShowEditor"]);

/** Profiles tab (G:44-58): profiles + the three checkboxes + refs.
 *  Nav profiles and loot profiles are filled in by the lists/route bridges. */
export function profilesTabView(options) {
  const list = safe(() => options?.profiles?.list?.(), []) || [];
  const active = profileSummary(options);
  const rows = new Map(allRows(options).map((r) => [r.key, r]));
  const toggles = {};
  for (const k of PROFILE_KEYS) toggles[k] = rows.get(k) || null;
  const ref = (n) => safe(() => options?.getRef?.(n), null);
  return {
    profiles: list.map((p) => ({
      name: String(p.name ?? ""),
      kind: String(p.kind ?? ""),
      label: String(p.label ?? p.name ?? ""),
    })),
    active,
    mineOnly: !!(active && (active.kind === "char" || active.kind === "bychar")),
    readOnly: !!(active && active.readOnly),
    banner: active && active.readOnly ? "Default is read-only — Save As to keep changes" : null,
    toggles,
    refs: { navProfile: ref("navProfile"), metaName: ref("metaName"), lootProfile: ref("lootProfile") },
    presets: ["vtank"],
  };
}

// ── commands ───────────────────────────────────────────────────────────────

/**
 * opt + profiles namespaces. `getOptions()` resolves the layer's VtOptions,
 * else the page session's (works with no bot).
 */
export function createOptionsCommands({ getOptions }) {
  const need = () => {
    const o = getOptions();
    if (!o) throw new Error("no VTank settings yet — log in first (the page session appears with the character)");
    return o;
  };
  const opt = {
    list: command((filter) => ok({ rows: allRows(need()).filter((r) => !filter || advancedMatch(r, filter)) })),
    get: command((name) => {
      const r = need().get(String(name ?? ""), { vtUnits: false });
      return r && r.ok ? ok({ key: r.key ?? r.row?.key, value: r.value, row: r.row ? rowView({ row: r.row, value: r.value }) : null }) : asResult(r);
    }),
    set: command((name, value) => asResult(need().set(String(name ?? ""), value, { source: "ui" }))),
    applyPreset: command((name) => asResult(need().applyPreset(String(name ?? "vtank")))),
  };
  const profiles = {
    list: command(() => {
      const o = need();
      return ok({ profiles: safe(() => o.profiles.list(), []) || [], active: profileSummary(o) });
    }),
    select: command((name, kind) => asResult(need().selectProfile(name, kind))),
    saveAs: command((name, mineOnly = false) => asResult(need().saveAs(String(name ?? "").trim(), { mineOnly: !!mineOnly }))),
    remove: command((name, kind) => {
      const o = need();
      const a = safe(() => o.profiles.active(), null);
      const isActive =
        a && (kind ? a.kind === kind : true) && String(a.name).toLowerCase() === String(name ?? "").toLowerCase();
      // Removing the active profile: select Default first so the loops get
      // Default's values through the authority (ProfileStore.remove alone
      // would switch silently, without a push or an onChange).
      if (isActive) {
        const s = o.selectProfile("Default", "default");
        if (s && s.ok === false) return asResult(s);
      }
      if (!o.profiles || !isFn(o.profiles.remove)) return fail("profiles cannot be removed here");
      return asResult(o.profiles.remove(name, kind));
    }),
    setMineOnly: command((on) => asResult(need().setMineOnly(!!on))),
    importHud: command(() => asResult(need().importHud())),
  };
  return { opt, profiles };
}

function advancedMatch(r, filter) {
  const f = String(filter).trim().toLowerCase();
  if (!f) return true;
  return [r.key, r.label, r.group, r.page, ...r.vtNames].some((s) => String(s).toLowerCase().includes(f));
}
