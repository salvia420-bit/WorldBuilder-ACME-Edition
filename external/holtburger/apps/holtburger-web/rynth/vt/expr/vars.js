// rynth/vt/expr/vars.js — VarStore: session / persistent (per character) /
// global meta variables (PLAN §3.4, §3.17; U5 §5.4).
//
//   session ("session")  in memory, page lifetime (the page-level VtSession
//                        keeps it across bot rebinds, D6/D33); holds any Value
//                        by reference (lists/dicts/stopwatches stay live).
//   pvars   ("p")        localStorage "rynth.vt.v1.pvars.<scope>"
//   gvars   ("g")        localStorage "rynth.vt.v1.gvars" (origin-wide)
//
// Names are case-insensitive (the first-seen spelling is kept for display).
// p/g writes mark the kind dirty; flush() writes at most once per flushMs
// (2 s, like RynthAi VarFlushIntervalMs) unless forced. Only scalars
// (number/string/bool/None) are persisted — lists, dicts, world objects,
// coordinates and stopwatches set into a p/g var live for the session only.
// Every storage access is try/catch'd; a failed write keeps the in-memory
// value and logs once.
//
// gvars are shared by every tab of the origin (two characters, L-P1): a read
// re-loads the key when its stored text changed since this store last saw
// it (this store's unwritten edits re-applied on top), and flush() merges
// only this store's own sets/clears into a fresh read of the key — another
// tab's keys are never dropped (review logic-4; C# rewrote the whole file).

import { makeLog } from "./values.js";

const PVARS_PREFIX = "rynth.vt.v1.pvars.";
const GVARS_KEY = "rynth.vt.v1.gvars";

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

function isScalar(v) {
  return v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

function persistable(v) {
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return v;
}

export class VarStore {
  constructor({ storage = null, scope = "0", now = Date.now, flushMs = 2000, log } = {}) {
    this.storage = storage && typeof storage.getItem === "function" ? storage : memoryStorage();
    this.scope = String(scope ?? "0");
    this.now = typeof now === "function" ? now : Date.now;
    this.flushMs = Number.isFinite(flushMs) ? flushMs : 2000;
    this.log = makeLog(log, () => this.now(), "[vt:expr]");
    this._session = new Map(); // lower → { name, v }
    this._p = null; // lazily loaded
    this._g = null;
    this._dirtyP = false;
    this._dirtyG = false;
    this._lastFlush = -Infinity;
    // gvars bookkeeping (merge-on-write): the stored text the view was built
    // from, this store's unwritten edits (lower → {name, v} | {name, del}),
    // a pending clear-all, and session-only (non-scalar) values that survive
    // a re-load until overwritten or cleared.
    this._gRaw = undefined;
    this._gPend = new Map();
    this._gWipe = false;
    this._gVolatile = new Map();
  }

  get pvarsKey() {
    return PVARS_PREFIX + this.scope;
  }

  _load(key) {
    let rawText = null;
    try {
      rawText = this.storage.getItem(key);
    } catch (e) {
      this.log(`vars: cannot read ${key}: ${e && e.message ? e.message : e}`);
      return new Map();
    }
    return this._parse(key, rawText);
  }

  _parse(key, rawText) {
    const m = new Map();
    if (!rawText) return m;
    try {
      const o = JSON.parse(rawText);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const name of Object.keys(o)) {
          const v = o[name];
          if (isScalar(v)) m.set(name.toLowerCase(), { name, v });
        }
      }
    } catch {
      this.log(`vars: ignoring unreadable ${key}`);
    }
    return m;
  }

  _map(kind) {
    if (kind === "p") return this._p || (this._p = this._load(this.pvarsKey));
    if (kind === "g") return this._gview();
    return this._session;
  }

  /** The gvars view: re-built when the stored text changed (another tab
   *  flushed), with this store's unwritten edits and session-only values
   *  laid on top. An unreadable key keeps the current view. */
  _gview() {
    let raw;
    try {
      raw = this.storage.getItem(GVARS_KEY);
    } catch (e) {
      this.log(`vars: cannot read ${GVARS_KEY}: ${e && e.message ? e.message : e}`);
      if (!this._g) this._g = new Map();
      return this._g;
    }
    if (raw === undefined) raw = null;
    if (this._g && raw === this._gRaw) return this._g;
    const m = this._parse(GVARS_KEY, raw);
    this._gRaw = raw;
    if (this._gWipe) m.clear();
    for (const [lower, e] of this._gVolatile) m.set(lower, { name: e.name, v: e.v });
    for (const [lower, e] of this._gPend) {
      if (e.del) m.delete(lower);
      else m.set(lower, { name: (m.get(lower) || e).name, v: e.v });
    }
    this._g = m;
    return m;
  }

  /** Record a gvar edit for the next merge-on-write. */
  _gNote(lower, entry) {
    this._gPend.set(lower, entry);
    if (entry.del || isScalar(entry.v)) this._gVolatile.delete(lower);
    else this._gVolatile.set(lower, { name: entry.name, v: entry.v });
  }

  _markDirty(kind) {
    if (kind === "p") this._dirtyP = true;
    else if (kind === "g") this._dirtyG = true;
  }

  get(kind, name) {
    const e = this._map(kind).get(String(name ?? "").toLowerCase());
    return e ? e.v : undefined;
  }

  set(kind, name, v) {
    const key = String(name ?? "");
    if (key === "") return v;
    const m = this._map(kind);
    const lower = key.toLowerCase();
    const prev = m.get(lower);
    const entry = { name: prev ? prev.name : key, v: v === undefined ? null : v };
    m.set(lower, entry);
    if (kind === "g") this._gNote(lower, { name: entry.name, v: entry.v });
    this._markDirty(kind);
    return v;
  }

  has(kind, name) {
    return this._map(kind).has(String(name ?? "").toLowerCase());
  }

  clear(kind, name) {
    const lower = String(name ?? "").toLowerCase();
    const m = this._map(kind);
    const prev = m.get(lower);
    const existed = m.delete(lower);
    if (existed) {
      if (kind === "g") this._gNote(lower, { name: prev.name, del: true });
      this._markDirty(kind);
    }
    return existed;
  }

  clearAll(kind) {
    const m = this._map(kind);
    if (m.size) this._markDirty(kind);
    m.clear();
    if (kind === "g") {
      this._gWipe = true;
      this._gPend.clear();
      this._gVolatile.clear();
    }
  }

  names(kind) {
    return [...this._map(kind).values()].map((e) => e.name);
  }

  _write(key, map) {
    return this._writeRaw(key, map) !== undefined;
  }

  /** → the stored text (null = key removed), or undefined when the write failed. */
  _writeRaw(key, map) {
    const o = {};
    let n = 0;
    for (const { name, v } of map.values()) {
      if (!isScalar(v)) continue;
      o[name] = persistable(v);
      n++;
    }
    try {
      if (n === 0) {
        this.storage.removeItem(key);
        return null;
      }
      const text = JSON.stringify(o);
      this.storage.setItem(key, text);
      return text;
    } catch (e) {
      this.log(`vars: cannot write ${key}: ${e && e.message ? e.message : e}`);
      return undefined;
    }
  }

  /** Merge this store's gvar edits into a fresh read of the key and write it. */
  _flushG() {
    let raw = null;
    try {
      raw = this.storage.getItem(GVARS_KEY);
    } catch (e) {
      this.log(`vars: cannot read ${GVARS_KEY}: ${e && e.message ? e.message : e}`);
      return false;
    }
    const base = this._parse(GVARS_KEY, raw === undefined ? null : raw);
    if (this._gWipe) base.clear();
    for (const [lower, e] of this._gPend) {
      if (e.del || !isScalar(e.v)) base.delete(lower);
      else base.set(lower, { name: (base.get(lower) || e).name, v: e.v });
    }
    const text = this._writeRaw(GVARS_KEY, base);
    if (text === undefined) return false;
    this._gPend.clear();
    this._gWipe = false;
    for (const [lower, e] of this._gVolatile) base.set(lower, { name: e.name, v: e.v });
    this._g = base;
    this._gRaw = text;
    return true;
  }

  // Writes dirty p/g vars; throttled to one write per flushMs unless forced.
  flush({ force = false } = {}) {
    if (!this._dirtyP && !this._dirtyG) return false;
    const t = Number(this.now()) || 0;
    if (!force && t - this._lastFlush < this.flushMs) return false;
    if (this._dirtyP && this._p && this._write(this.pvarsKey, this._p)) this._dirtyP = false;
    if (this._dirtyG && this._flushG()) this._dirtyG = false;
    this._lastFlush = t;
    return true;
  }

  // Character switch (scope = player guid): persist the old pvars, reload lazily.
  setScope(scope) {
    const s = String(scope ?? "0");
    if (s === this.scope) return;
    this.flush({ force: true });
    this.scope = s;
    this._p = null;
    this._dirtyP = false;
  }

  // Session vars for the page-level VtSession (values kept by reference).
  exportSession() {
    return { v: 1, vars: [...this._session.values()].map((e) => [e.name, e.v]) };
  }

  importSession(o) {
    this._session.clear();
    const rows = o && Array.isArray(o.vars) ? o.vars : [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 1) continue;
      const name = String(row[0] ?? "");
      if (name === "") continue;
      this._session.set(name.toLowerCase(), { name, v: row[1] === undefined ? null : row[1] });
    }
  }
}
