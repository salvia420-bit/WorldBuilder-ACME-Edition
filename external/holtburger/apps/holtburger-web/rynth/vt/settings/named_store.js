// rynth/vt/settings/named_store.js — generic named JSON blob store (nav
// profiles, meta library, loot profiles; PLAN §3.5, §3.17) plus the small
// storage/value helpers the rest of the settings package shares.
//
// NamedStore: one localStorage key per name, `prefix + name.toLowerCase()`,
// value `{ name, savedAt, value }` (the display spelling is kept in `name`).
// Names are case-insensitive; put() overwrites. Every storage access is
// try/catch'd: a failed write (QuotaExceededError, blocked storage) returns
// `{ ok: false, error }` and changes nothing — the caller keeps its in-memory
// state. `storage === null` (or anything without getItem) ⇒ an in-memory map.
//
// Listing needs key enumeration: a real Storage (`length` + `key(i)`) is
// enumerated; a bare {getItem,setItem,removeItem} fake is not enumerable, so
// keys written through this module are also remembered per storage object
// (a WeakMap index shared by every store on that storage) and listed.

// ── logging (C3) ───────────────────────────────────────────────────────────
/** A `[vt:<module>]`-prefixed logger; identical messages at most once / 10 s. */
export function makeLogger(log, now, prefix) {
  const out = typeof log === "function" ? log : (m) => console.log(m);
  const clock = typeof now === "function" ? now : Date.now;
  const last = new Map();
  return (msg) => {
    const text = `${prefix} ${msg}`;
    try {
      const t = clock();
      const prev = last.get(text);
      if (prev !== undefined && t - prev < 10_000) return;
      if (last.size > 256) last.clear();
      last.set(text, t);
      out(text);
    } catch {
      /* logging must never throw */
    }
  };
}

// ── value helpers ─────────────────────────────────────────────────────────
/** JSON-safe deep clone (profile values are plain data). */
export function clone(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

/** Structural equality over plain data (arrays, objects, primitives). */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

/** JSON with sorted object keys (stable change detection for autosave). */
export function canonicalJson(v) {
  const walk = (x) => {
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map((e) => (e === undefined ? null : walk(e)));
    const o = {};
    for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = walk(x[k]);
    return o;
  };
  try {
    return JSON.stringify(walk(v));
  } catch {
    return "";
  }
}

// ── storage adapter ───────────────────────────────────────────────────────
const knownKeys = new WeakMap(); // storage object → Set<key> written through this module

function isStorage(s) {
  return !!s && typeof s.getItem === "function" && typeof s.setItem === "function";
}

function isQuotaError(e) {
  if (!e) return false;
  const name = String(e.name || "");
  const code = Number(e.code);
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014
    || /quota/i.test(String(e.message || ""));
}

/**
 * Wrap a Storage-like object (or null ⇒ a private in-memory map).
 * → { memory, get(key) → string|null, set(key, str) → {ok, error?},
 *     remove(key) → {ok, error?}, keys(prefix) → string[] }
 */
export function createKv(storage, log = () => {}) {
  if (!isStorage(storage)) {
    const mem = new Map();
    return {
      memory: true,
      raw: null,
      get: (k) => (mem.has(k) ? mem.get(k) : null),
      set: (k, v) => {
        mem.set(k, String(v));
        return { ok: true };
      },
      remove: (k) => {
        mem.delete(k);
        return { ok: true };
      },
      keys: (prefix) => [...mem.keys()].filter((k) => k.startsWith(prefix)),
    };
  }
  let index = knownKeys.get(storage);
  if (!index) {
    index = new Set();
    knownKeys.set(storage, index);
  }
  return {
    memory: false,
    raw: storage,
    get(k) {
      try {
        const v = storage.getItem(k);
        return v === null || v === undefined ? null : String(v);
      } catch (e) {
        log(`storage read failed (${k}): ${e && e.message ? e.message : e}`);
        return null;
      }
    },
    set(k, v) {
      try {
        storage.setItem(k, String(v));
        index.add(k);
        return { ok: true };
      } catch (e) {
        const error = isQuotaError(e)
          ? `storage is full (quota exceeded): ${k} was not saved`
          : `storage write failed (${k}): ${e && e.message ? e.message : e}`;
        log(error);
        return { ok: false, error };
      }
    },
    remove(k) {
      try {
        if (typeof storage.removeItem === "function") storage.removeItem(k);
        index.delete(k);
        return { ok: true };
      } catch (e) {
        const error = `storage remove failed (${k}): ${e && e.message ? e.message : e}`;
        log(error);
        return { ok: false, error };
      }
    },
    keys(prefix) {
      const out = new Set();
      try {
        const n = storage.length;
        if (typeof n === "number" && typeof storage.key === "function") {
          for (let i = 0; i < n; i++) {
            const k = storage.key(i);
            if (typeof k === "string" && k.startsWith(prefix)) out.add(k);
          }
        }
      } catch (e) {
        log(`storage enumeration failed: ${e && e.message ? e.message : e}`);
      }
      for (const k of index) {
        if (!k.startsWith(prefix) || out.has(k)) continue;
        // Remembered key: still present? (another tab may have removed it)
        let present = false;
        try {
          present = storage.getItem(k) !== null && storage.getItem(k) !== undefined;
        } catch {
          present = false;
        }
        if (present) out.add(k);
        else index.delete(k);
      }
      return [...out];
    },
  };
}

// ── NamedStore ────────────────────────────────────────────────────────────
const MAX_NAME = 200;

export class NamedStore {
  /** @param {{ storage?: object|null, prefix: string, now?: () => number, log?: (m: string) => void }} opts */
  constructor({ storage = null, prefix, now = Date.now, log } = {}) {
    this.prefix = String(prefix || "rynth.vt.v1.named.");
    this.now = typeof now === "function" ? now : Date.now;
    this.log = makeLogger(log, () => this.now(), "[vt:settings]");
    this._kv = createKv(storage, this.log);
    // list() memo: key → { fp, entry } — a record is re-parsed only when its
    // stored text changed (fingerprint = length + head + tail: every put()
    // rewrites savedAt in the head), so a panel refreshing every 500 ms does
    // not JSON.parse a whole meta library each time (review runtime-7).
    this._listMemo = new Map();
  }

  _name(name) {
    if (typeof name !== "string" && typeof name !== "number") return null;
    const n = String(name).trim();
    if (!n || n.length > MAX_NAME || /[\u0000-\u001f]/.test(n)) return null;
    return n;
  }

  _key(name) {
    return this.prefix + name.toLowerCase();
  }

  _read(key) {
    return this._parse(key, this._kv.get(key));
  }

  _parse(key, raw) {
    if (raw === null || raw === undefined) return null;
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec === "object" && Object.prototype.hasOwnProperty.call(rec, "value")) return { rec, bytes: raw.length };
    } catch {
      /* fall through */
    }
    this.log(`ignoring unreadable record ${key}`);
    return null;
  }

  /** → Array<{ name, savedAt, bytes }> sorted by name (case-insensitive). */
  list() {
    const out = [];
    const seen = new Set();
    for (const key of this._kv.keys(this.prefix)) {
      seen.add(key);
      const raw = this._kv.get(key);
      if (raw === null || raw === undefined) continue;
      const fp = `${raw.length}:${raw.slice(0, 256)}\u0000${raw.slice(-64)}`;
      let m = this._listMemo.get(key);
      if (!m || m.fp !== fp) {
        const r = this._parse(key, raw);
        let entry = null;
        if (r) {
          const name = typeof r.rec.name === "string" && r.rec.name ? r.rec.name : key.slice(this.prefix.length);
          entry = { name, savedAt: Number(r.rec.savedAt) || 0, bytes: r.bytes };
        }
        m = { fp, entry };
        this._listMemo.set(key, m);
      }
      if (m.entry) out.push({ ...m.entry });
    }
    for (const k of [...this._listMemo.keys()]) if (!seen.has(k)) this._listMemo.delete(k);
    out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
    return out;
  }

  /** → the stored value (a fresh copy) or null. */
  get(name) {
    const n = this._name(name);
    if (!n) return null;
    const r = this._read(this._key(n));
    return r ? r.rec.value : null;
  }

  /** True when get(name) would return a record (an unreadable one is skipped, as in list()). */
  has(name) {
    const n = this._name(name);
    return !!n && this._read(this._key(n)) !== null;
  }

  /** Overwrite. → { ok: true } | { ok: false, error } (nothing changes on failure). */
  put(name, value) {
    const n = this._name(name);
    if (!n) return { ok: false, error: `invalid name ${JSON.stringify(name)}` };
    if (value === undefined) return { ok: false, error: "nothing to save (value is undefined)" };
    let text;
    try {
      text = JSON.stringify({ name: n, savedAt: this.now(), value });
    } catch (e) {
      return { ok: false, error: `cannot serialise ${n}: ${e && e.message ? e.message : e}` };
    }
    if (typeof text !== "string") return { ok: false, error: `cannot serialise ${n}` };
    return this._kv.set(this._key(n), text);
  }

  remove(name) {
    const n = this._name(name);
    if (!n) return { ok: false, error: `invalid name ${JSON.stringify(name)}` };
    return this._kv.remove(this._key(n));
  }
}
