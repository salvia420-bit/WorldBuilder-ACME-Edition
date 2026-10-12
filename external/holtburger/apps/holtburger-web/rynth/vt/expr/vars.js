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
  }

  get pvarsKey() {
    return PVARS_PREFIX + this.scope;
  }

  _load(key) {
    const m = new Map();
    let rawText = null;
    try {
      rawText = this.storage.getItem(key);
    } catch (e) {
      this.log(`vars: cannot read ${key}: ${e && e.message ? e.message : e}`);
      return m;
    }
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
    if (kind === "g") return this._g || (this._g = this._load(GVARS_KEY));
    return this._session;
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
    m.set(lower, { name: prev ? prev.name : key, v: v === undefined ? null : v });
    this._markDirty(kind);
    return v;
  }

  has(kind, name) {
    return this._map(kind).has(String(name ?? "").toLowerCase());
  }

  clear(kind, name) {
    const existed = this._map(kind).delete(String(name ?? "").toLowerCase());
    if (existed) this._markDirty(kind);
    return existed;
  }

  clearAll(kind) {
    const m = this._map(kind);
    if (m.size) this._markDirty(kind);
    m.clear();
  }

  names(kind) {
    return [...this._map(kind).values()].map((e) => e.name);
  }

  _write(key, map) {
    const o = {};
    let n = 0;
    for (const { name, v } of map.values()) {
      if (!isScalar(v)) continue;
      o[name] = persistable(v);
      n++;
    }
    try {
      if (n === 0) this.storage.removeItem(key);
      else this.storage.setItem(key, JSON.stringify(o));
      return true;
    } catch (e) {
      this.log(`vars: cannot write ${key}: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  // Writes dirty p/g vars; throttled to one write per flushMs unless forced.
  flush({ force = false } = {}) {
    if (!this._dirtyP && !this._dirtyG) return false;
    const t = Number(this.now()) || 0;
    if (!force && t - this._lastFlush < this.flushMs) return false;
    if (this._dirtyP && this._p && this._write(this.pvarsKey, this._p)) this._dirtyP = false;
    if (this._dirtyG && this._g && this._write(GVARS_KEY, this._g)) this._dirtyG = false;
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
