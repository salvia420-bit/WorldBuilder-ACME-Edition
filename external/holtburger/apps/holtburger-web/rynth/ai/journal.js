// journal.js — bounded rolling journal of director decisions/outcomes/notes;
// localStorage-persisted in a page, pure-memory under node; never throws on
// quota or corrupt storage. INTERFACE FROZEN — see rynth/ai/SPEC.md §journal.

const KINDS = new Set(["plan", "result", "note", "error", "budget"]);

// Resolved per call, not cached at module load: tests (and pages) may install
// or remove a global localStorage after this module is imported.
function storage() {
  try {
    const s = globalThis.localStorage;
    return s && typeof s.getItem === "function" && typeof s.setItem === "function"
      ? s
      : null;
  } catch {
    return null; // sandboxed contexts can throw on the localStorage getter itself
  }
}

function normalizeKind(kind) {
  return KINDS.has(kind) ? kind : "note"; // SPEC: unknown kind -> "note"
}

// Strict shape check + whitelist copy: only {t, kind, text} survive, so an
// imported/stored blob can't smuggle extra keys into journal state. Any bad
// element rejects the whole batch (import must be all-or-nothing).
function sanitizeEntries(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) return null;
    if (!Number.isFinite(e.t) || typeof e.kind !== "string" || typeof e.text !== "string") return null;
    out.push({ t: e.t, kind: normalizeKind(e.kind), text: e.text });
  }
  return out;
}

export class AiJournal {
  constructor({ storageKey = "holtburger_ai_journal_v1", maxEntries = 200 } = {}) {
    this.storageKey = storageKey;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries >= 1 ? Math.floor(maxEntries) : 200;
    this.entries = [];
    this._load();
  }

  _load() {
    const s = storage();
    if (!s) return;
    try {
      const raw = s.getItem(this.storageKey);
      if (!raw) return;
      const parsed = sanitizeEntries(JSON.parse(raw));
      if (parsed) this.entries = parsed.slice(-this.maxEntries);
    } catch {
      // corrupt stored JSON / storage access denied — stay memory-only (SPEC: never throw)
    }
  }

  _save() {
    const s = storage();
    if (!s) return;
    try {
      s.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch {
      // quota exceeded / storage disabled — degrade to memory (SPEC: never throw)
    }
  }

  add(kind, text) {
    this.entries.push({ t: Date.now(), kind: normalizeKind(kind), text: String(text ?? "") });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this._save();
  }

  tail(n = 10) {
    if (!(n > 0)) return []; // guard: slice(-0) would return the whole array
    return this.entries.slice(-Math.floor(n)).map((e) => ({ ...e }));
  }

  renderTail(n = 10, maxChars = 2000) {
    if (!(maxChars > 0)) return "";
    const lines = this.tail(n).map((e) => {
      const d = new Date(e.t);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm} ${e.kind}: ${e.text.replace(/\s+/g, " ").trim()}`;
    });
    // Fit the budget newest-first, emit chronological (newest-last): oldest
    // lines are dropped first when over maxChars.
    const kept = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = lines[i].length + (kept.length ? 1 : 0); // +1 for the "\n" join
      if (used + cost > maxChars) break;
      kept.unshift(lines[i]);
      used += cost;
    }
    // Even the newest line alone is over budget: keep its prefix rather than
    // returning nothing (the prompt still gets the freshest context).
    if (!kept.length && lines.length) return lines[lines.length - 1].slice(0, maxChars);
    return kept.join("\n");
  }

  export() {
    return JSON.stringify(this.entries);
  }

  import(json) {
    if (typeof json !== "string") return false;
    let parsed;
    try {
      parsed = sanitizeEntries(JSON.parse(json));
    } catch {
      return false;
    }
    if (!parsed) return false;
    this.entries = parsed.slice(-this.maxEntries);
    this._save();
    return true;
  }

  clear() {
    this.entries = [];
    this._save();
  }
}
