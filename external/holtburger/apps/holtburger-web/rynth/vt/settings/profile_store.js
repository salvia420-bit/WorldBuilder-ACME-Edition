// rynth/vt/settings/profile_store.js — VTank settings profiles per character
// (PLAN §3.5, §3.17, §4; U7a §3; GUIDE:44-58).
//
// Kinds:
//   default  "Default" — schema defaults + an in-memory overlay (page session
//            lifetime, survives bot rebinds through the VtSession). NEVER
//            written to storage (GUIDE:48 "default … cannot be changed").
//   bychar   "[By char]" — rynth.vt.v1.profile.char.<scope>.__bychar__,
//            created from the current live values on first select (C#
//            LoadProfile → SaveAsProfile).
//   shared   rynth.vt.v1.profile.shared.<Name> — every character lists it.
//   char     rynth.vt.v1.profile.char.<scope>.<Name> — "[Char] <Name>", only
//            this character lists it (Mine Only).
// The active profile is rynth.vt.v1.active.<scope> = {name, kind}; Default
// is "no marker" (selecting Default removes it, so Default is never written).
//
// Record: { v:1, name, kind, rev, savedAt, settings, lists, refs, charName? }.
// `settings` holds canonical keys (normally only values ≠ default — VtOptions
// writes the diff), `lists` the tab lists (LIST_KEYS), `refs` the nav / meta /
// loot names (REF_KEYS). Run state is never profile data.
//
// Every storage access is try/catch'd (createKv). A failed write returns
// { ok:false, error } and keeps the in-memory record (still dirty, so the next
// flush retries).

import { createKv, makeLogger, clone } from "./named_store.js";
import { VITALS_FIELD_KEYS } from "./schema.js";

export const PROFILE_PREFIX = "rynth.vt.v1.profile.";
export const SHARED_PREFIX = "rynth.vt.v1.profile.shared.";
export const ACTIVE_PREFIX = "rynth.vt.v1.active.";
export const HUD_BLOB_KEY = "rynth.hud.settings.v1"; // = rynth/hud_bridge.js HUD_SETTINGS_KEY
export const DEFAULT_NAME = "Default";
export const BYCHAR_NAME = "[By char]";
export const BYCHAR_ID = "__bychar__";
/** Save As rule: no spaces (GUIDE:54), a safe storage-key suffix. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_'\-]{1,40}$/;
const RESERVED = new Set(["default", "[by char]", BYCHAR_ID]);
const KINDS = new Set(["default", "bychar", "shared", "char"]);
const DEFAULT_RO = "Default is read-only — Save As first";

export const charPrefix = (scope) => `${PROFILE_PREFIX}char.${scope}.`;

function emptySection() {
  return { settings: {}, lists: {}, refs: {} };
}

function plainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/** Normalise a parsed record (tolerates missing sections). */
function normaliseRecord(o, fallbackName, kind) {
  if (!plainObject(o)) return null;
  return {
    v: 1,
    name: typeof o.name === "string" && o.name ? o.name : fallbackName,
    kind,
    rev: Number.isFinite(o.rev) ? o.rev : 0,
    savedAt: Number.isFinite(o.savedAt) ? o.savedAt : 0,
    ...(typeof o.charName === "string" ? { charName: o.charName } : {}),
    settings: { ...(plainObject(o.settings) || {}) },
    lists: { ...(plainObject(o.lists) || {}) },
    refs: { ...(plainObject(o.refs) || {}) },
  };
}

/** Replace the contents of `target` with `src` in place (keeps the object). */
function replaceInto(target, src) {
  for (const k of Object.keys(target)) delete target[k];
  for (const [k, v] of Object.entries(src || {})) {
    if (v !== undefined && v !== null) target[k] = clone(v);
  }
}

/** Merge `src` into `target`; undefined/null deletes the key. */
function mergeInto(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v === undefined || v === null) delete target[k];
    else target[k] = clone(v);
  }
}

export class ProfileStore {
  /**
   * @param {{ storage?: object|null, scope: string, charName?: string, now?: () => number,
   *           log?: (m: string) => void, win?: object|null }} opts
   */
  constructor({ storage = null, scope, charName = "", now = Date.now, log, win = null } = {}) {
    this.now = typeof now === "function" ? now : Date.now;
    this.log = makeLogger(log, () => this.now(), "[vt:settings]");
    this._storage = storage && typeof storage.getItem === "function" ? storage : null;
    this._kv = createKv(storage, this.log);
    this._scope = String(scope ?? "pending") || "pending";
    this._charName = typeof charName === "string" ? charName : "";
    this._win = win && typeof win === "object" ? win : null;
    this._overlay = emptySection();
    this._active = { kind: "default", name: DEFAULT_NAME, key: null };
    this._rec = null;
    this._dirty = false;
    this._lastWritten = null;
    this._extListeners = new Set();
    this._storageHandler = null;
    this._restoreActive();
  }

  get scope() {
    return this._scope;
  }
  get charName() {
    return this._charName;
  }
  setCharName(name) {
    if (typeof name === "string" && name) this._charName = name;
  }
  /** The injected Storage (null = in-memory). */
  get storage() {
    return this._storage;
  }
  /** True while the active user profile has edits not yet written. */
  get dirty() {
    return this._dirty;
  }

  // ── keys ────────────────────────────────────────────────────────────────
  _activeMarkerKey() {
    return ACTIVE_PREFIX + this._scope;
  }
  _prefixFor(kind) {
    return kind === "shared" ? SHARED_PREFIX : charPrefix(this._scope);
  }
  _keyFor(kind, name) {
    if (kind === "bychar") return charPrefix(this._scope) + BYCHAR_ID;
    return this._prefixFor(kind) + name;
  }
  /** Existing storage key for (kind, name): exact spelling, else case-insensitive. */
  _findKey(kind, name) {
    if (kind === "bychar") {
      const k = this._keyFor("bychar");
      return this._kv.get(k) !== null ? k : null;
    }
    if (typeof name !== "string" || !name) return null;
    const exact = this._keyFor(kind, name);
    if (this._kv.get(exact) !== null) return exact;
    const prefix = this._prefixFor(kind);
    const lower = name.toLowerCase();
    for (const k of this._kv.keys(prefix)) {
      const suffix = k.slice(prefix.length);
      if (suffix === BYCHAR_ID || suffix.includes(".")) continue;
      if (suffix.toLowerCase() === lower) return k;
    }
    return null;
  }
  _readRecord(key, kind) {
    const raw = this._kv.get(key);
    if (raw === null) return null;
    try {
      const fallback = kind === "bychar" ? BYCHAR_NAME : key.slice(this._prefixFor(kind).length);
      const rec = normaliseRecord(JSON.parse(raw), fallback, kind);
      if (rec) return rec;
    } catch {
      /* fall through */
    }
    this.log(`ignoring unreadable profile ${key}`);
    return null;
  }

  _restoreActive() {
    const raw = this._kv.get(this._activeMarkerKey());
    if (raw === null) return;
    let m = null;
    try {
      m = JSON.parse(raw);
    } catch {
      m = null;
    }
    if (!plainObject(m) || !KINDS.has(m.kind) || m.kind === "default") return;
    const key = this._findKey(m.kind, m.name);
    const rec = key ? this._readRecord(key, m.kind) : null;
    if (!rec) {
      this.log(`active profile ${JSON.stringify(m.name)} (${m.kind}) is missing — using Default`);
      return;
    }
    this._activate(m.kind, rec.name, key, rec);
    this._lastWritten = this._kv.get(key);
  }

  _activate(kind, name, key, rec) {
    this._active = { kind, name, key };
    this._rec = rec;
    this._dirty = false;
  }

  _writeMarker() {
    if (this._active.kind === "default") return this._kv.remove(this._activeMarkerKey());
    return this._kv.set(this._activeMarkerKey(), JSON.stringify({ name: this._active.name, kind: this._active.kind }));
  }

  _newRecord(name, kind, current) {
    const src = current && typeof current === "object" ? current : this.record();
    const rec = normaliseRecord(
      { name, settings: clone(src.settings) || {}, lists: clone(src.lists) || {}, refs: clone(src.refs) || {} },
      name,
      kind,
    );
    rec.savedAt = this.now();
    if (kind !== "shared" && this._charName) rec.charName = this._charName;
    for (const [k, v] of Object.entries(rec.refs)) if (v === null || v === undefined) delete rec.refs[k];
    return rec;
  }

  _writeRecord(key, rec) {
    const text = JSON.stringify(rec);
    const r = this._kv.set(key, text);
    if (r.ok) this._lastWritten = text;
    return r;
  }

  // ── public API ──────────────────────────────────────────────────────────
  /** Default, [By char], shared A-Z, then this character's "[Char] <Name>". */
  list() {
    const out = [
      { name: DEFAULT_NAME, kind: "default", label: DEFAULT_NAME },
      { name: BYCHAR_NAME, kind: "bychar", label: BYCHAR_NAME },
    ];
    const names = (prefix) => this._kv.keys(prefix)
      .map((k) => k.slice(prefix.length))
      .filter((n) => n && n !== BYCHAR_ID && !n.includes("."))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
    for (const n of names(SHARED_PREFIX)) out.push({ name: n, kind: "shared", label: n });
    for (const n of names(charPrefix(this._scope))) out.push({ name: n, kind: "char", label: `[Char] ${n}` });
    return out;
  }

  active() {
    return { name: this._active.name, kind: this._active.kind, writable: this._active.kind !== "default" };
  }

  isUserProfileActive() {
    return this._active.kind !== "default";
  }

  /** The active profile's sections (Default ⇒ the overlay). Live objects —
   *  read only; write through patch(). */
  record() {
    if (!this._rec) return this._overlay;
    return this._rec;
  }

  /** The Default-session overlay (edits made while Default is active). */
  overlay() {
    return this._overlay;
  }

  /** Resolve a (name, kind) request; kind omitted ⇒ inferred from the name. */
  _resolve(name, kind) {
    const n = typeof name === "string" ? name.trim() : "";
    if (kind === "default" || (!kind && n.toLowerCase() === "default")) return { kind: "default", name: DEFAULT_NAME };
    if (kind === "bychar" || (!kind && n.toLowerCase() === BYCHAR_NAME.toLowerCase())) return { kind: "bychar", name: BYCHAR_NAME };
    if (kind && kind !== "shared" && kind !== "char") return { error: `unknown profile kind ${JSON.stringify(kind)}` };
    if (!n) return { error: "profile name is empty" };
    if (n.startsWith("[Char] ")) return this._resolve(n.slice(7), "char");
    if (kind) {
      const key = this._findKey(kind, n);
      return key ? { kind, name: key.slice(this._prefixFor(kind).length), key } : { error: `no ${kind} profile named "${n}"` };
    }
    for (const k of ["char", "shared"]) {
      const key = this._findKey(k, n);
      if (key) return { kind: k, name: key.slice(this._prefixFor(k).length), key };
    }
    return { error: `no profile named "${n}"` };
  }

  /**
   * Select a profile. `current` ({settings, lists, refs}) seeds [By char] the
   * first time. Flushes the outgoing profile first (C# SwitchProfile).
   * → { ok: true, record, error? } | { ok: false, error }
   */
  select(name, kind, { current } = {}) {
    const t = this._resolve(name, kind);
    if (t.error) return { ok: false, error: t.error };
    const a = this._active;
    if (t.kind === a.kind && (t.kind === "default" || t.kind === "bychar" || t.key === a.key)) {
      return { ok: true, record: this.record() };
    }
    if (this._dirty) {
      const f = this.flush();
      if (!f.ok) this.log(`switching profile with unsaved edits in "${a.name}": ${f.error}`);
    }
    if (t.kind === "default") {
      this._activate("default", DEFAULT_NAME, null, null);
      this._writeMarker();
      return { ok: true, record: this.record() };
    }
    let saveError;
    let key = t.key;
    let rec = null;
    if (t.kind === "bychar") {
      key = this._keyFor("bychar");
      rec = this._readRecord(key, "bychar");
      if (!rec) {
        rec = this._newRecord(BYCHAR_NAME, "bychar", current);
        const w = this._writeRecord(key, rec);
        if (!w.ok) saveError = w.error;
      }
    } else {
      rec = this._readRecord(key, t.kind);
      if (!rec) return { ok: false, error: `profile "${t.name}" is unreadable` };
    }
    this._activate(t.kind, t.kind === "bychar" ? BYCHAR_NAME : t.name, key, rec);
    if (saveError) this._dirty = true;
    const m = this._writeMarker();
    if (!m.ok && !saveError) saveError = m.error;
    return saveError ? { ok: true, record: this.record(), error: saveError } : { ok: true, record: this.record() };
  }

  /**
   * Save the current values under a new name and select it (C# SaveAsProfile).
   * mineOnly ⇒ a "[Char]" profile. Overwrites an existing profile of that
   * name (case-insensitive) and kind. → { ok } | { ok: false, error }
   */
  saveAs(name, { mineOnly = false, current } = {}) {
    if (typeof name !== "string") return { ok: false, error: "profile name is empty" };
    if (RESERVED.has(name.trim().toLowerCase())) return { ok: false, error: `"${name}" is a reserved profile name` };
    if (!PROFILE_NAME_RE.test(name)) {
      return { ok: false, error: `invalid profile name "${name}": use 1-40 letters, digits, _ ' - (no spaces)` };
    }
    const kind = mineOnly ? "char" : "shared";
    if (this._dirty) this.flush();
    const rec = this._newRecord(name, kind, current);
    const key = this._keyFor(kind, name);
    const prev = this._findKey(kind, name);
    const w = this._writeRecord(key, rec);
    if (!w.ok) return { ok: false, error: w.error };
    if (prev && prev !== key) this._kv.remove(prev);
    this._activate(kind, name, key, rec);
    const m = this._writeMarker();
    return m.ok ? { ok: true } : { ok: true, error: m.error };
  }

  /**
   * Mine Only (GUIDE:55): on ⇒ a shared profile is copied into this
   * character's scope under the same name and selected (the shared one stays
   * for other characters); off ⇒ a [Char] profile becomes shared (refused when
   * a shared profile of that name exists). → { ok } | { ok: false, error }
   */
  setMineOnly(on, { current } = {}) {
    const a = this._active;
    if (a.kind === "default") return { ok: false, error: DEFAULT_RO };
    if (a.kind === "bychar") return on ? { ok: true } : { ok: false, error: "[By char] is always character-only" };
    if (on && a.kind === "char") return { ok: true };
    if (!on && a.kind === "shared") return { ok: true };
    if (on) return this.saveAs(a.name, { mineOnly: true, current });
    if (this._findKey("shared", a.name)) return { ok: false, error: `a shared profile named "${a.name}" already exists` };
    const oldKey = a.key;
    const r = this.saveAs(a.name, { mineOnly: false, current });
    if (r.ok && oldKey) this._kv.remove(oldKey);
    return r;
  }

  /** Delete a stored profile; removing the active one selects Default. */
  remove(name, kind) {
    const t = this._resolve(name, kind);
    if (t.error) return { ok: false, error: t.error };
    if (t.kind === "default") return { ok: false, error: "Default cannot be removed" };
    const key = t.kind === "bychar" ? this._keyFor("bychar") : t.key;
    if (this._kv.get(key) === null) return { ok: false, error: `no profile "${t.name}"` };
    const r = this._kv.remove(key);
    if (!r.ok) return { ok: false, error: r.error };
    if (this._active.key === key) {
      this._activate("default", DEFAULT_NAME, null, null);
      this._writeMarker();
    }
    return { ok: true };
  }

  /**
   * Merge into the active record (Default ⇒ the overlay). A null/undefined
   * value deletes the key. `replace: true` replaces each given section.
   */
  patch({ settings, lists, refs } = {}, { replace = false } = {}) {
    const target = this.record();
    const apply = replace ? replaceInto : mergeInto;
    const s = plainObject(settings);
    const l = plainObject(lists);
    const r = plainObject(refs);
    if (s) apply(target.settings, s);
    if (l) apply(target.lists, l);
    if (r) apply(target.refs, r);
    if (this._rec && (s || l || r)) this._dirty = true;
  }

  /** Write the active user record when dirty (or forced). Default never writes. */
  flush({ force = false } = {}) {
    if (!this._rec) return { ok: true, wrote: false };
    if (!this._dirty && !force) return { ok: true, wrote: false };
    const rec = this._rec;
    rec.rev = (Number(rec.rev) || 0) + 1;
    rec.savedAt = this.now();
    if (rec.kind !== "shared" && this._charName) rec.charName = this._charName;
    const r = this._writeRecord(this._active.key, rec);
    if (!r.ok) {
      rec.rev -= 1;
      this._dirty = true;
      return { ok: false, wrote: false, error: r.error };
    }
    this._dirty = false;
    return { ok: true, wrote: true };
  }

  /**
   * Multi-tab: `storage` events for the ACTIVE record key. With no unsaved
   * edits here the record is reloaded and fn({ kind: "reload", name,
   * profileKind, before, after }) runs; otherwise this tab keeps its edits
   * (last writer wins, logged). → unsubscribe
   */
  onExternalChange(fn) {
    if (typeof fn !== "function") return () => {};
    this._extListeners.add(fn);
    this._ensureStorageListener();
    return () => {
      this._extListeners.delete(fn);
      if (this._extListeners.size === 0) this._dropStorageListener();
    };
  }

  _ensureStorageListener() {
    if (this._storageHandler || !this._win || typeof this._win.addEventListener !== "function") return;
    this._storageHandler = (e) => {
      try {
        this._onStorageEvent(e);
      } catch (err) {
        this.log(`storage event handling failed: ${err && err.message ? err.message : err}`);
      }
    };
    try {
      this._win.addEventListener("storage", this._storageHandler);
    } catch {
      this._storageHandler = null;
    }
  }

  _dropStorageListener() {
    if (!this._storageHandler) return;
    try {
      this._win.removeEventListener?.("storage", this._storageHandler);
    } catch {
      /* ignore */
    }
    this._storageHandler = null;
  }

  _onStorageEvent(e) {
    if (!e || typeof e.key !== "string" || !this._rec || e.key !== this._active.key) return;
    if (e.newValue === this._lastWritten) return;
    if (this._dirty) {
      this.log(`profile "${this._active.name}" changed in another tab; keeping this tab's unsaved edits (last writer wins)`);
      return;
    }
    if (e.newValue === null || e.newValue === undefined) {
      this.log(`profile "${this._active.name}" was removed in another tab; keeping it in memory`);
      return;
    }
    let parsed = null;
    try {
      parsed = normaliseRecord(JSON.parse(e.newValue), this._active.name, this._active.kind);
    } catch {
      parsed = null;
    }
    if (!parsed) return;
    const before = clone({ settings: this._rec.settings, lists: this._rec.lists, refs: this._rec.refs });
    this._rec.rev = parsed.rev;
    this._rec.savedAt = parsed.savedAt;
    replaceInto(this._rec.settings, parsed.settings);
    replaceInto(this._rec.lists, parsed.lists);
    replaceInto(this._rec.refs, parsed.refs);
    this._lastWritten = e.newValue;
    const evt = { kind: "reload", name: this._active.name, profileKind: this._active.kind, before, after: this._rec };
    for (const fn of [...this._extListeners]) {
      try {
        fn(evt);
      } catch (err) {
        this.log(`external-change listener failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  /** The HUD blob converted for this store's storage (see migrateHudBlob). */
  hudBlob() {
    return ProfileStore.migrateHudBlob(this._storage, this._scope, { now: this.now });
  }

  /**
   * Read-only conversion of the origin-wide HUD blob `rynth.hud.settings.v1`
   * (D27, §4.7): vitals → the vitals keys; lootMin → LootMinValue; buffs →
   * lists.buffs.spec; priorities → lists.legacyPriorities; route/persona →
   * nothing. → { settings, lists } | null (no blob / nothing usable).
   */
  static migrateHudBlob(storage, scope, { now } = {}) {
    void scope;
    void now;
    let blob = null;
    try {
      const raw = storage && typeof storage.getItem === "function" ? storage.getItem(HUD_BLOB_KEY) : null;
      blob = raw ? JSON.parse(raw) : null;
    } catch {
      blob = null;
    }
    if (!plainObject(blob)) return null;
    const settings = {};
    const lists = {};
    if (plainObject(blob.vitals)) {
      for (const [field, v] of Object.entries(blob.vitals)) {
        const key = VITALS_FIELD_KEYS[field];
        const n = Number(v);
        if (key && v !== null && v !== "" && Number.isFinite(n) && n >= 0 && n <= 100) settings[key] = Math.round(n);
      }
    }
    if (blob.lootMin !== null && blob.lootMin !== undefined && blob.lootMin !== "") {
      const n = Number(blob.lootMin);
      if (Number.isFinite(n) && n >= 0) settings.LootMinValue = Math.min(1e9, Math.round(n));
    }
    if (blob.buffs === "auto") {
      lists.buffs = { spec: "auto", disabled: [], itemSpells: {} };
    } else if (Array.isArray(blob.buffs)) {
      const ids = [...new Set(blob.buffs.map(Number).filter((x) => Number.isInteger(x) && x > 0 && x <= 0xFFFFFFFF))];
      if (ids.length) lists.buffs = { spec: ids, disabled: [], itemSpells: {} };
    }
    if (plainObject(blob.priorities)) {
      const pr = {};
      for (const [k, v] of Object.entries(blob.priorities)) {
        const key = String(k).trim().toLowerCase();
        const n = Number(v);
        if (key && v !== null && v !== "" && Number.isFinite(n)) pr[key] = Math.max(0, Math.min(20, Math.round(n)));
      }
      if (Object.keys(pr).length) lists.legacyPriorities = pr;
    }
    if (!Object.keys(settings).length && !Object.keys(lists).length) return null;
    return { settings, lists };
  }
}
