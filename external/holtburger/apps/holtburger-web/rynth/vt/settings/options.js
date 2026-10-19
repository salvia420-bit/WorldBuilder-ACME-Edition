// rynth/vt/settings/options.js — VtOptions, THE settings authority (PLAN §3.5,
// §4; D4, D5, D19, D27).
//
// Every option read and write goes through here: `/rs opt`, meta GetOpt /
// SetOpt, the vtgetsetting/… expression functions, the monster variable
// `setting_X`, the VT panel and the HUD (noteLegacyEdit / hudBootOverrides).
//
// Storage model:
//   * a bound live cell (cells.js) IS the value for legacy-backed keys;
//   * otherwise the active profile record (Default ⇒ the in-memory overlay);
//   * otherwise the schema default.
// Profiles hold the DIFF from the schema defaults (settings), the tab lists
// and the refs. set()/setList()/setRef()/noteLegacyEdit() from an explicit
// source save at once under a user profile ("immediately saved", G:48);
// autosaveTick() (2 s) catches cell drift written by the HUD, the director or
// `!bot`. Default is never written.
//
// Profile application (§4.5):
//   applyToCells({ legacy, urlPinned })  first attach on a page: legacy=true
//     pushes every key the record stores (except URL pins); the profile-owned
//     keys (MonsterRange, CorpseApproachRangeMax, RebuffSecondsRemaining) are
//     always pushed with their resolved value.
//   selectProfile(name, kind)  pushes every key of the new profile (no pins —
//     explicit operator action) and fires onChange({ kind: "profile" }). It does
//     NOT load the refs (navProfile/metaName/lootProfile): INT-2 does that on
//     kind:"profile" events only.
// URL-pinned keys are never absorbed into a profile by autosave / Save As.
//
// Never throws: every public method returns { ok, error? } or a value.

import {
  SCHEMA, LIST_KEYS, REF_KEYS, LIST_DEFAULTS, PRESETS, VITALS_FIELD_KEYS,
  buildIndex, findRowIn, coerce, present, displayName,
} from "./schema.js";
import { makeLogger, clone, deepEqual, canonicalJson } from "./named_store.js";
import { PROFILE_OWNED_CELLS, BOOT_UNCARRIED_CELLS } from "./cells.js";

const AUTOSAVE_MS = 2000;
const EXPLICIT_SOURCES = new Set(["ui", "command", "meta", "hud", "preset", "import"]);
const DEFAULT_RO = "Default is read-only — Save As first";
const VITALS_KEY_FIELDS = Object.fromEntries(Object.entries(VITALS_FIELD_KEYS).map(([f, k]) => [k, f]));

const errText = (e) => String(e && e.message ? e.message : e);

/** Short, stable text for an echoed value (7 significant digits for floats). */
function fmtValue(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(7)));
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null || v === undefined) return "";
  return String(v);
}

function normPriorities(v) {
  const out = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v)) {
    const key = String(k).trim().toLowerCase();
    const x = Number(n);
    if (key && n !== null && n !== "" && Number.isFinite(x)) out[key] = Math.max(0, Math.min(99, Math.round(x)));
  }
  return out;
}

function normBuffSpec(spec) {
  if (spec === "auto") return "auto";
  if (Array.isArray(spec)) return [...new Set(spec.map(Number).filter((x) => Number.isInteger(x) && x > 0 && x <= 0xFFFFFFFF))];
  return null;
}

/** Validate / normalise a list value by name. → { ok, value } | { ok:false, error } */
function normaliseList(name, value) {
  switch (name) {
    case "buffs": {
      if (value === null || value === undefined) return { ok: true, value: clone(LIST_DEFAULTS.buffs) };
      if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "buffs: expected {spec, disabled, itemSpells}" };
      const disabled = Array.isArray(value.disabled)
        ? [...new Set(value.disabled.map(Number).filter((x) => Number.isInteger(x) && x > 0))]
        : [];
      const itemSpells = {};
      if (value.itemSpells && typeof value.itemSpells === "object" && !Array.isArray(value.itemSpells)) {
        for (const [g, fams] of Object.entries(value.itemSpells)) {
          if (Array.isArray(fams)) itemSpells[String(g)] = fams.filter((f) => typeof f === "string" && f).map(String);
        }
      }
      return { ok: true, value: { ...clone(value), spec: normBuffSpec(value.spec), disabled, itemSpells } };
    }
    case "legacyPriorities":
      if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
        return { ok: false, error: "legacyPriorities: expected {name: priority}" };
      }
      return { ok: true, value: normPriorities(value) };
    case "items":
    case "consumables":
      if (value !== null && value !== undefined && !Array.isArray(value)) return { ok: false, error: `${name}: expected an array` };
      return { ok: true, value: clone(value ?? []) };
    case "monsters":
      if (value !== null && value !== undefined && !Array.isArray(value)) return { ok: false, error: "monsters: expected an array" };
      return { ok: true, value: value == null ? null : clone(value) }; // null ⇒ drop the list (DEFAULT only)
    default:
      return { ok: false, error: `unknown list ${JSON.stringify(name)} (known: ${LIST_KEYS.join(", ")})` };
  }
}

/**
 * @param {{ schema?: ReadonlyArray<object>, profiles: import("./profile_store.js").ProfileStore,
 *           cells?: object|null, log?: (m: string) => void, now?: () => number }} opts
 */
export function createVtOptions({ schema = SCHEMA, profiles, cells = null, log, now = Date.now } = {}) {
  const clock = typeof now === "function" ? now : Date.now;
  const say = makeLogger(log, clock, "[vt:settings]");
  const index = buildIndex(schema);
  const rows = index.rows;
  const listeners = new Set();
  const bagMap = new Map(); // lower → { name, value }
  const pushedOwner = new Map(); // profile-owned cell key → loop object last pushed to
  let boundCells = null;
  let pinned = new Set();
  let lastAutosaveAt = -Infinity;
  let baseline = null;
  // bot.setBuffs() is async and serialised (bot.js sets bot.buffSpec when a
  // call's turn RUNS, after the previous call's spell-ladder load), so right
  // after a push bot.buffSpec still shows the outgoing spec. The spec handed
  // over last is the live one until then — reads, the immediate save and a
  // revert must not see (or persist) the old one. { spec (normalised), from? }:
  // without `from` it is a push of ours, cleared when that call settles; with
  // `from` (noteLegacyEdit: the HUD pushed, no promise here) it is cleared as
  // soon as bot.buffSpec moves away from `from`.
  let buffsAhead = null;

  // ── reads ───────────────────────────────────────────────────────────────
  const rec = () => profiles.record();
  const rowOf = (key) => index.byKey.get(key) || findRowIn(index, String(key ?? ""))?.row || null;
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  function storedValue(row) {
    const s = rec().settings;
    return has(s, row.key) ? s[row.key] : row.dflt;
  }

  function cellValue(key) {
    if (!boundCells || !boundCells.has(key)) return undefined;
    try {
      return boundCells.get(key);
    } catch {
      return undefined;
    }
  }

  function getValue(key) {
    const row = rowOf(key);
    if (!row) return undefined;
    if (row.cell) {
      const v = cellValue(row.key);
      if (v !== undefined) return v;
    }
    return storedValue(row);
  }

  function recordList(name) {
    const l = rec().lists;
    if (has(l, name)) return l[name];
    return LIST_DEFAULTS[name] ?? null;
  }

  /** The bot's buff spec as it is about to be (normalised): an in-flight push
   *  (buffsAhead), else bot.buffSpec. undefined = no buffs cell on this bot. */
  function liveBuffSpec() {
    const live = cellValue("buffs");
    if (!live || typeof live !== "object") return undefined;
    const now = normBuffSpec(live.spec);
    if (buffsAhead && buffsAhead.from !== undefined && !deepEqual(now, buffsAhead.from)) buffsAhead = null;
    return buffsAhead ? clone(buffsAhead.spec) : now;
  }

  /** A bot.setBuffs(spec) call of ours is in flight until `pending` settles. */
  function trackBuffsPush(spec, pending) {
    const s = normBuffSpec(spec);
    if (s === null || !pending || typeof pending.then !== "function") return;
    const token = { spec: s };
    buffsAhead = token;
    const done = () => {
      if (buffsAhead === token) buffsAhead = null;
    };
    Promise.resolve(pending).then(done, done);
  }

  /** The HUD pushed `spec` itself (noteLegacyEdit): treat it as live until the
   *  bot shows a change (no promise to wait on here). */
  function expectBuffSpec(spec) {
    const s = normBuffSpec(spec);
    const live = cellValue("buffs");
    if (s === null || !live || typeof live !== "object") return;
    const now = normBuffSpec(live.spec);
    if (deepEqual(now, s)) return;
    buffsAhead = { spec: s, from: now };
  }

  function liveList(name) {
    const stored = recordList(name);
    if (name === "buffs") {
      const live = liveBuffSpec();
      const base = { ...clone(LIST_DEFAULTS.buffs), ...(stored && typeof stored === "object" ? clone(stored) : {}) };
      if (live !== undefined) base.spec = live;
      return base;
    }
    if (name === "legacyPriorities") {
      const live = cellValue("legacyPriorities");
      return live !== undefined ? clone(live) : clone(stored ?? {});
    }
    return clone(stored);
  }

  function ctx() {
    return { getValue, recordList, buffSpec: liveBuffSpec };
  }

  function emit(evt) {
    for (const fn of [...listeners]) {
      try {
        fn(evt);
      } catch (e) {
        say(`onChange listener failed: ${errText(e)}`);
      }
    }
  }

  // ── snapshot / persistence ──────────────────────────────────────────────
  /** { settings (≠ default), lists, refs } with cells read live; forSave reads
   *  URL-pinned keys from the profile instead of the cells. */
  function snapshot({ forSave = false } = {}) {
    const settings = {};
    for (const row of rows) {
      const v = forSave && pinned.has(row.key) ? storedValue(row) : getValue(row.key);
      if (v !== undefined && !deepEqual(v, row.dflt)) settings[row.key] = clone(v);
    }
    const r = rec();
    // keys this schema does not know (a newer build wrote them) round-trip untouched
    for (const [k, v] of Object.entries(r.settings)) if (!index.byKey.has(k)) settings[k] = clone(v);
    const lists = {};
    for (const name of LIST_KEYS) {
      const cellBacked = name === "buffs" || name === "legacyPriorities";
      if (cellBacked && boundCells && !(forSave && pinned.has(name))) {
        const live = liveList(name);
        if (has(r.lists, name) || !deepEqual(live, LIST_DEFAULTS[name])) lists[name] = live;
      } else if (has(r.lists, name)) {
        lists[name] = clone(r.lists[name]);
      }
    }
    for (const name of Object.keys(r.lists)) if (!LIST_KEYS.includes(name)) lists[name] = clone(r.lists[name]);
    const refs = {};
    for (const [k, v] of Object.entries(r.refs)) if (v !== null && v !== undefined) refs[k] = clone(v);
    return { settings, lists, refs };
  }

  /** The active record in snapshot form (settings diff only). */
  function recordForm() {
    const r = rec();
    const settings = {};
    for (const [k, v] of Object.entries(r.settings)) {
      const row = index.byKey.get(k);
      if (!row || !deepEqual(v, row.dflt)) settings[k] = v;
    }
    const refs = {};
    for (const [k, v] of Object.entries(r.refs)) if (v !== null && v !== undefined) refs[k] = v;
    return { settings, lists: r.lists, refs };
  }

  function resetBaseline() {
    baseline = profiles.isUserProfileActive() ? canonicalJson(recordForm()) : null;
  }

  /** Persist the full live state into the active user profile now. */
  function saveNow() {
    if (!profiles.isUserProfileActive()) return { ok: true, wrote: false };
    syncCells();
    const s = snapshot({ forSave: true });
    const str = canonicalJson(s);
    if (str !== baseline || profiles.dirty) {
      profiles.patch(s, { replace: true });
      const r = profiles.flush();
      if (!r.ok) {
        say(`profile "${profiles.active().name}" not saved: ${r.error}`);
        return r;
      }
      baseline = str;
      return r;
    }
    return { ok: true, wrote: false };
  }

  function persist(source) {
    if (!profiles.isUserProfileActive() || !EXPLICIT_SOURCES.has(source)) return null;
    const r = saveNow();
    return r.ok ? null : r.error;
  }

  /** Before switching away from / copying a user profile (C# SwitchProfile,
   *  SaveAsProfile): persist its live state, incl. cell drift the 2 s autosave
   *  has not written yet (ProfileStore only flushes edits made through patch). */
  function flushOutgoing() {
    if (profiles.isUserProfileActive()) saveNow();
  }

  // ── cell pushes ─────────────────────────────────────────────────────────
  function pushSetting(row, v, { force = false } = {}) {
    if (!boundCells || !row.cell || !boundCells.has(row.key)) return { ok: true, pushed: false };
    // No loop behind the cell (EnableBuffing excepted: it can build one): the profile keeps the value.
    if (typeof boundCells.owner === "function" && row.key !== "EnableBuffing" && !boundCells.owner(row.key)) {
      return { ok: true, pushed: false };
    }
    const cur = cellValue(row.key);
    if (!force && cur !== undefined && deepEqual(cur, v)) return { ok: true, pushed: false };
    if (cur === undefined && deepEqual(v, row.dflt) && !PROFILE_OWNED_CELLS.includes(row.key)) {
      return { ok: true, pushed: false }; // no loop + default: nothing to do (never builds a loop implicitly)
    }
    // EnableBuffing false with no buff loop: nothing to stop (keepBuffingOff
    // re-applies it once a buff list builds the loop).
    if (row.key === "EnableBuffing" && cur === undefined && v !== true) return { ok: true, pushed: false };
    let r;
    try {
      r = boundCells.set(row.key, v, ctx()) || { ok: true };
    } catch (e) {
      r = { ok: false, error: errText(e) };
    }
    if (!r.ok) say(`cannot apply ${row.key}: ${r.error}`);
    if (r.ok && r.pending && row.key === "EnableBuffing") trackBuffsPush(r.spec, r.pending);
    return { ...r, pushed: !!r.ok };
  }

  function pushList(name, value) {
    if (!boundCells || !boundCells.has(name)) return { ok: true, pushed: false };
    const live = cellValue(name);
    if (name === "legacyPriorities") {
      const v = normPriorities(value);
      if (live === undefined ? Object.keys(v).length === 0 : deepEqual(normPriorities(live), v)) return { ok: true, pushed: false };
    } else if (name === "buffs") {
      const spec = normBuffSpec(value?.spec);
      if (spec === null || live === undefined || deepEqual(liveBuffSpec(), spec)) return { ok: true, pushed: false };
    }
    let r;
    try {
      r = boundCells.set(name, clone(value), ctx()) || { ok: true };
    } catch (e) {
      r = { ok: false, error: errText(e) };
    }
    if (!r.ok) say(`cannot apply list ${name}: ${r.error}`);
    if (name === "buffs" && r.ok && r.pending) {
      trackBuffsPush(r.spec ?? value?.spec, r.pending);
      keepBuffingOff(r.pending);
    }
    return { ...r, pushed: !!r.ok };
  }

  /** bot.setBuffs() (a profile/Buffs-tab buff list) may BUILD the buff loop,
   *  and a new loop starts enabled. When the active profile stores
   *  EnableBuffing=false (and it is not URL-pinned), switch the loop off once
   *  it exists — otherwise selecting such a profile turns buffing on and the
   *  next autosave persists that. Promise continuation, not a timer (C4). */
  function keepBuffingOff(pending) {
    const row = index.byKey.get("EnableBuffing");
    if (!row || pinned.has("EnableBuffing") || storedValue(row) !== false) return;
    Promise.resolve(pending).then(() => {
      try {
        if (!pinned.has("EnableBuffing") && storedValue(row) === false) pushSetting(row, false);
      } catch (e) {
        say(`cannot keep buffing off: ${errText(e)}`);
      }
    }, () => {});
  }

  function noteOwners() {
    if (!boundCells || typeof boundCells.owner !== "function") return;
    for (const key of PROFILE_OWNED_CELLS) pushedOwner.set(key, boundCells.owner(key) || null);
  }

  /** Re-push the profile-owned cells whose loop appeared or was replaced since
   *  the last push (e.g. bot.setBuffs() building the buff loop). */
  function syncCells() {
    if (!boundCells || typeof boundCells.owner !== "function") return [];
    const pushed = [];
    for (const key of PROFILE_OWNED_CELLS) {
      const row = index.byKey.get(key);
      if (!row || !boundCells.has(key)) continue;
      const owner = boundCells.owner(key) || null;
      if (owner === (pushedOwner.has(key) ? pushedOwner.get(key) : null)) continue;
      pushedOwner.set(key, owner);
      if (owner && pushSetting(row, storedValue(row)).pushed) pushed.push(key);
    }
    return pushed;
  }

  /** Push every key of the active profile (selectProfile / external reload).
   *  `skip` = keys left alone (the URL pins on an external reload; an explicit
   *  selectProfile lifts them and passes none). */
  function pushAll({ skip = null } = {}) {
    if (!boundCells) return [];
    const pushed = [];
    const r = rec();
    const skipped = (k) => !!skip && skip.has(k);
    const buffsList = has(r.lists, "buffs") ? r.lists.buffs : null;
    if (!skipped("buffs") && buffsList && normBuffSpec(buffsList.spec) !== null && pushList("buffs", buffsList).pushed) {
      pushed.push("buffs");
    }
    if (!skipped("legacyPriorities")
      && pushList("legacyPriorities", has(r.lists, "legacyPriorities") ? r.lists.legacyPriorities : {}).pushed) {
      pushed.push("legacyPriorities");
    }
    for (const row of rows) {
      if (!row.cell || skipped(row.key)) continue;
      if (pushSetting(row, storedValue(row)).pushed) pushed.push(row.key);
    }
    boundCells.refreshDerived?.(ctx());
    noteOwners();
    return pushed;
  }

  // ── writes ──────────────────────────────────────────────────────────────
  function setInternal(name, raw, source) {
    const f = findRowIn(index, typeof name === "string" ? name : String(name ?? ""));
    if (!f) return { ok: false, error: `unknown option ${name}` };
    const { row, viaVt } = f;
    const c = coerce(row, raw, { viaVt });
    if (!c.ok) return { ok: false, error: c.error };
    const v = c.value;
    if (row.cell && boundCells && boundCells.has(row.key)) {
      const cur = cellValue(row.key);
      if (cur === undefined || !deepEqual(cur, v)) {
        let r;
        try {
          r = boundCells.set(row.key, v, ctx()) || { ok: true };
        } catch (e) {
          r = { ok: false, error: errText(e) };
        }
        if (!r.ok) return { ok: false, error: r.error };
        if (r.pending && row.key === "EnableBuffing") trackBuffsPush(r.spec, r.pending);
      }
      if (PROFILE_OWNED_CELLS.includes(row.key) && typeof boundCells.owner === "function") {
        pushedOwner.set(row.key, boundCells.owner(row.key) || null);
      }
    }
    profiles.patch({ settings: { [row.key]: deepEqual(v, row.dflt) ? undefined : v } });
    // host.nearbyRangeM = max(base, MonsterRange+5, ApproachRange+5): re-derive
    // once the new value is readable (MonsterRange with no combat loop reads it
    // from the record).
    if ((row.key === "ApproachRange" || row.key === "MonsterRange" || row.key === "MonsterDisengageRange") && boundCells) {
      boundCells.refreshDerived?.(ctx());
    }
    const shown = fmtValue(present(row, v, { viaVt }));
    const inert = row.consumer === "inert";
    const echo = `[RynthSuite] Set option ${String(name).trim()} = ${shown}${inert ? " (not implemented on web)" : ""}`;
    emit({ kind: "setting", key: row.key, value: v, source });
    return { ok: true, value: v, row, echo, ...(c.clamped ? { clamped: true } : {}) };
  }

  function setListInternal(name, value, source, { push = true } = {}) {
    if (!LIST_KEYS.includes(name)) return { ok: false, error: `unknown list ${JSON.stringify(name)} (known: ${LIST_KEYS.join(", ")})` };
    const n = normaliseList(name, value);
    if (!n.ok) return n;
    if (push && (name === "buffs" || name === "legacyPriorities")) {
      const r = pushList(name, n.value);
      if (!r.ok) return { ok: false, error: r.error };
    }
    profiles.patch({ lists: { [name]: n.value === null ? undefined : n.value } });
    emit({ kind: "list", key: name, value: clone(n.value), source });
    return { ok: true, value: n.value };
  }

  const withSave = (r, source) => {
    if (!r.ok) return r;
    const err = persist(source);
    return err ? { ...r, saveError: err } : r;
  };

  // ── external change (another tab saved the active profile) ──────────────
  try {
    profiles.onExternalChange?.((evt) => {
      if (!evt || evt.kind !== "reload") return;
      pushAll({ skip: pinned }); // another tab's save is not an operator action here: the URL pins hold
      resetBaseline();
      const before = evt.before || { settings: {}, lists: {}, refs: {} };
      const after = evt.after || rec();
      const keys = new Set([...Object.keys(before.settings || {}), ...Object.keys(after.settings || {})]);
      for (const k of keys) {
        if (!deepEqual(before.settings?.[k], after.settings?.[k])) emit({ kind: "setting", key: k, value: getValue(k), source: "external" });
      }
      const lnames = new Set([...Object.keys(before.lists || {}), ...Object.keys(after.lists || {})]);
      for (const k of lnames) {
        if (!deepEqual(before.lists?.[k], after.lists?.[k])) emit({ kind: "list", key: k, value: clone(after.lists?.[k] ?? null), source: "external" });
      }
      const rnames = new Set([...Object.keys(before.refs || {}), ...Object.keys(after.refs || {})]);
      for (const k of rnames) {
        if (!deepEqual(before.refs?.[k], after.refs?.[k])) emit({ kind: "ref", key: k, value: after.refs?.[k] ?? null, source: "external" });
      }
    });
  } catch (e) {
    say(`multi-tab sync unavailable: ${errText(e)}`);
  }

  resetBaseline();

  // ── the VtOptions object ────────────────────────────────────────────────
  const api = {
    profiles,
    schema: rows,

    get(name, { vtUnits = false, exactCase = false } = {}) {
      try {
        const f = findRowIn(index, typeof name === "string" ? name : String(name ?? ""), { exactCase });
        if (!f) return { ok: false, error: `unknown option ${name}` };
        const value = present(f.row, getValue(f.row.key), { viaVt: vtUnits && f.viaVt });
        return { ok: true, value, row: f.row, key: f.row.key, viaVt: f.viaVt };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    set(name, raw, { source = "ui" } = {}) {
      try {
        return withSave(setInternal(name, raw, source), source);
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    getValue(key) {
      try {
        return getValue(key);
      } catch {
        return undefined;
      }
    },

    /** Profile/overlay value (or default), ignoring live cells. */
    storedValue(key) {
      try {
        const row = rowOf(key);
        return row ? storedValue(row) : undefined;
      } catch {
        return undefined;
      }
    },

    list(filter) {
      const out = [];
      try {
        const f = typeof filter === "string" || typeof filter === "number" ? String(filter).trim().toLowerCase() : "";
        for (const row of rows) {
          if (f) {
            const hay = [row.key, ...row.vt, row.label, row.group, row.page].map((s) => String(s).toLowerCase());
            if (!hay.some((s) => s.includes(f))) continue;
          }
          const value = getValue(row.key);
          out.push({
            key: row.key,
            vtName: displayName(row),
            value,
            vtValue: present(row, value, { viaVt: row.vt.length > 0 }),
            dflt: row.dflt,
            inert: row.consumer === "inert",
            row,
          });
        }
      } catch (e) {
        say(`list failed: ${errText(e)}`);
      }
      return out;
    },

    getList(name) {
      try {
        if (!LIST_KEYS.includes(name)) {
          const l = rec().lists;
          return has(l, name) ? clone(l[name]) : null;
        }
        return liveList(name);
      } catch {
        return null;
      }
    },

    setList(name, value, { source = "ui" } = {}) {
      try {
        return withSave(setListInternal(name, value, source), source);
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    getRef(name) {
      try {
        const v = rec().refs[name];
        return typeof v === "string" && v ? v : null;
      } catch {
        return null;
      }
    },

    setRef(name, value, { source = "ui" } = {}) {
      try {
        if (!REF_KEYS.includes(name)) return { ok: false, error: `unknown ref ${JSON.stringify(name)} (known: ${REF_KEYS.join(", ")})` };
        const v = value === null || value === undefined || value === "" ? null : String(value);
        profiles.patch({ refs: { [name]: v } });
        emit({ kind: "ref", key: name, value: v, source });
        return withSave({ ok: true, value: v }, source);
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    bindCells(c) {
      boundCells = c && typeof c.has === "function" && typeof c.get === "function" && typeof c.set === "function" ? c : null;
      pushedOwner.clear();
      buffsAhead = null; // an in-flight spec belonged to the previous bot
    },

    /** §4.5 attach-time push. → { pushed: string[] } */
    applyToCells({ legacy = false, urlPinned } = {}) {
      const pushed = [];
      try {
        pinned = urlPinned instanceof Set ? new Set(urlPinned) : new Set(Array.isArray(urlPinned) ? urlPinned : []);
        if (!boundCells) return { pushed };
        const r = rec();
        if (legacy) {
          // (a buff list that builds the loop also re-applies a stored
          // EnableBuffing=false once the loop exists: pushList → keepBuffingOff)
          for (const name of ["buffs", "legacyPriorities"]) {
            if (pinned.has(name) || !has(r.lists, name)) continue;
            if (name === "buffs" && normBuffSpec(r.lists.buffs?.spec) === null) continue;
            const p = pushList(name, r.lists[name]);
            if (p.pushed) pushed.push(name);
          }
        }
        for (const row of rows) {
          if (!row.cell) continue;
          if (PROFILE_OWNED_CELLS.includes(row.key)) {
            if (pushSetting(row, storedValue(row)).pushed) pushed.push(row.key);
          } else if ((legacy || BOOT_UNCARRIED_CELLS.includes(row.key)) && has(r.settings, row.key) && !pinned.has(row.key)) {
            // legacy:false still re-applies the stored keys no boot path carries
            // to a rebuilt bot (cells.js BOOT_UNCARRIED_CELLS)
            if (pushSetting(row, r.settings[row.key]).pushed) pushed.push(row.key);
          }
        }
        boundCells.refreshDerived?.(ctx());
        noteOwners();
      } catch (e) {
        say(`applyToCells failed: ${errText(e)}`);
      }
      return { pushed };
    },

    syncCells() {
      try {
        return syncCells();
      } catch {
        return [];
      }
    },

    snapshot(opts) {
      try {
        return snapshot(opts);
      } catch (e) {
        say(`snapshot failed: ${errText(e)}`);
        return { settings: {}, lists: {}, refs: {} };
      }
    },

    autosaveTick(nowMs) {
      try {
        const t = Number.isFinite(nowMs) ? nowMs : clock();
        // (a clock stepped backwards must not stall the autosave until it catches up)
        if (t >= lastAutosaveAt && t - lastAutosaveAt < AUTOSAVE_MS) return;
        lastAutosaveAt = t;
        syncCells();
        if (!profiles.isUserProfileActive()) return;
        saveNow();
      } catch (e) {
        say(`autosave failed: ${errText(e)}`);
      }
    },

    flushNow() {
      try {
        saveNow();
        profiles.flush();
      } catch (e) {
        say(`flush failed: ${errText(e)}`);
      }
    },

    selectProfile(name, kind) {
      try {
        const current = snapshot({ forSave: true });
        const before = profiles.active();
        flushOutgoing();
        const r = profiles.select(name, kind, { current });
        if (!r.ok) return { ok: false, error: r.error };
        const after = profiles.active();
        // Already active: nothing to apply (C# SwitchProfile "same name ⇒ no-op").
        if (before.name === after.name && before.kind === after.kind) return { ok: true, active: after, pushed: [] };
        const pushed = pushAll();
        pinned = new Set(); // an explicit selection overrides the per-launch URL pins
        resetBaseline();
        const a = profiles.active();
        emit({ kind: "profile", key: a.name, value: { name: a.name, kind: a.kind }, source: "ui" });
        return r.error ? { ok: true, active: a, pushed, saveError: r.error } : { ok: true, active: a, pushed };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    saveAs(name, { mineOnly = false } = {}) {
      try {
        flushOutgoing();
        const r = profiles.saveAs(name, { mineOnly, current: snapshot({ forSave: true }) });
        if (r.ok) resetBaseline();
        return r.ok ? { ok: true, active: profiles.active() } : { ok: false, error: r.error };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    setMineOnly(on) {
      try {
        flushOutgoing();
        const r = profiles.setMineOnly(!!on, { current: snapshot({ forSave: true }) });
        if (r.ok) resetBaseline();
        return r.ok ? { ok: true, active: profiles.active() } : { ok: false, error: r.error };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    applyPreset(name) {
      try {
        const preset = PRESETS[String(name ?? "").toLowerCase()];
        if (!preset) return { ok: false, error: `unknown preset ${JSON.stringify(name)} (known: ${Object.keys(PRESETS).join(", ")})` };
        if (!profiles.isUserProfileActive()) return { ok: false, error: DEFAULT_RO };
        const applied = [];
        for (const [k, v] of Object.entries(preset)) {
          const r = setInternal(k, v, "preset");
          if (r.ok) applied.push(k);
          else say(`preset ${name}: ${r.error}`);
        }
        return withSave({ ok: true, applied }, "preset");
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    importHud() {
      try {
        if (!profiles.isUserProfileActive()) return { ok: false, imported: [], error: DEFAULT_RO };
        const blob = typeof profiles.hudBlob === "function"
          ? profiles.hudBlob()
          : profiles.constructor?.migrateHudBlob?.(profiles.storage, profiles.scope, { now: clock }) ?? null;
        if (!blob) return { ok: false, imported: [], error: "no HUD settings found to import" };
        const imported = [];
        for (const [k, v] of Object.entries(blob.settings || {})) {
          const r = setInternal(k, v, "import");
          if (r.ok) imported.push(k);
        }
        for (const [name, v] of Object.entries(blob.lists || {})) {
          const value = name === "buffs" ? { ...recordList("buffs"), spec: v.spec } : v;
          const r = setListInternal(name, value, "import");
          if (r.ok) imported.push(name);
        }
        return withSave({ ok: true, imported }, "import");
      } catch (e) {
        return { ok: false, imported: [], error: errText(e) };
      }
    },

    /** applyHudOverrides shape from the active USER profile; null under Default. */
    hudBootOverrides() {
      try {
        if (!profiles.isUserProfileActive()) return null;
        const s = snapshot({ forSave: true });
        const o = {};
        const spec = normBuffSpec(s.lists.buffs?.spec);
        if (spec === "auto" || (Array.isArray(spec) && spec.length)) o.buffs = spec === "auto" ? "auto" : spec.slice();
        const pr = s.lists.legacyPriorities;
        if (pr && typeof pr === "object" && Object.keys(pr).length) o.priorities = { ...pr };
        if (has(s.settings, "LootMinValue")) o.lootMin = s.settings.LootMinValue;
        const vitals = {};
        for (const [key, field] of Object.entries(VITALS_KEY_FIELDS)) if (has(s.settings, key)) vitals[field] = s.settings[key];
        if (Object.keys(vitals).length) o.vitals = vitals;
        return o;
      } catch {
        return null;
      }
    },

    /** A HUD legacy setter ran (blob already written, live cell already set
     *  when a bot exists): record it in the active profile (Default ⇒ overlay). */
    noteLegacyEdit(field, value) {
      try {
        let r;
        switch (field) {
          case "priorities":
            r = setListInternal("legacyPriorities", value, "hud", { push: false });
            break;
          case "buffs": {
            const spec = normBuffSpec(value);
            // the HUD's own bot.setBuffs() may not have run yet (async)
            if (boundCells) expectBuffSpec(spec);
            r = setListInternal("buffs", { ...recordList("buffs"), spec }, "hud", { push: false });
            break;
          }
          case "lootMin": {
            const n = Number(value);
            if (value === null || value === "" || !Number.isFinite(n) || n < 0) return { ok: false, error: "lootMin: expected a number ≥ 0" };
            r = noteSetting("LootMinValue", n);
            break;
          }
          case "vitals": {
            if (!value || typeof value !== "object") return { ok: false, error: "vitals: expected {field: percent}" };
            const patch = {};
            for (const [k, v] of Object.entries(value)) {
              const key = VITALS_FIELD_KEYS[k] || (VITALS_KEY_FIELDS[k] ? k : null);
              const row = key ? index.byKey.get(key) : null;
              if (!row) continue;
              const c = coerce(row, v);
              if (c.ok) patch[key] = deepEqual(c.value, row.dflt) ? undefined : c.value;
            }
            if (!Object.keys(patch).length) return { ok: false, error: "vitals: nothing usable" };
            profiles.patch({ settings: patch });
            for (const [k, v] of Object.entries(patch)) emit({ kind: "setting", key: k, value: v ?? index.byKey.get(k).dflt, source: "hud" });
            r = { ok: true };
            break;
          }
          default:
            return { ok: false, error: `unknown legacy field ${JSON.stringify(field)}` };
        }
        return withSave(r, "hud");
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },

    onChange(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    bag: {
      get(name) {
        const e = bagMap.get(String(name ?? "").trim().toLowerCase());
        return e ? e.value : undefined;
      },
      set(name, v) {
        const n = String(name ?? "").trim();
        if (!n) return { ok: false, error: "empty option name" };
        bagMap.set(n.toLowerCase(), { name: n, value: v });
        return { ok: true };
      },
      has(name) {
        return bagMap.has(String(name ?? "").trim().toLowerCase());
      },
      names() {
        return [...bagMap.values()].map((e) => e.name);
      },
    },
  };

  function noteSetting(key, raw) {
    const row = index.byKey.get(key);
    const c = coerce(row, raw);
    if (!c.ok) return { ok: false, error: c.error };
    profiles.patch({ settings: { [key]: deepEqual(c.value, row.dflt) ? undefined : c.value } });
    emit({ kind: "setting", key, value: c.value, source: "hud" });
    return { ok: true, value: c.value };
  }

  if (cells) api.bindCells(cells);
  return api;
}
