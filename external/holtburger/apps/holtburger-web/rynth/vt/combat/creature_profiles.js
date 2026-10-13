// rynth/vt/combat/creature_profiles.js — per-wcid creature knowledge (PLAN
// W1-7 CMB, M17 Auto element, M23 species/maxhp). Species and max health are
// not in CreateObject (U4 row 17): one appraisal teaches them, and they are
// remembered per wcid (a species' resists and HP do not change per spawn) in
// localStorage "rynth.vt.v1.creatures" (LRU, 2000 wcids). Without an
// appraisal, species falls back to the offline table
// rynth/vt/data/creature_species.json (LSD partial weenie summary, generated
// by rynth/vt/tools/gen_creature_species.cjs) — X-partial for wcids the dump
// lacks.
//
// Appraisal shape (webhost TryGetObjectAppraisal, EX-05 JSON):
//   properties.ints.CreatureType (or "2"), creatureProfile.health_max (or the
//   failedCreatureProfile of a failed assess), properties.floats.Resist<El>
//   (or ids 64-70, 166 — ACE PropertyFloat.cs). Resist values are damage
//   multipliers (ACE Creature_Properties.cs `(ResistFire ?? 1.0) * …`,
//   SpellProjectile.cs `* resistanceMod`): HIGHER = more damage taken = weaker
//   to that element; 0 = immune; unset = 1.0.

import { ELEMENTS } from "./spell_tables.js";

export const CREATURES_STORAGE_KEY = "rynth.vt.v1.creatures";
const LRU_MAX = 2000;
const WRITE_MIN_INTERVAL_MS = 10_000; // storage writes are throttled (no timers: on the next note)

// ACE PropertyFloat ids (Enum/Properties/PropertyFloat.cs:79-85, :201).
const RESIST_PROPS = Object.freeze([
  ["Slash", "ResistSlash", 64],
  ["Pierce", "ResistPierce", 65],
  ["Bludgeon", "ResistBludgeon", 66],
  ["Fire", "ResistFire", 67],
  ["Cold", "ResistCold", 68],
  ["Acid", "ResistAcid", 69],
  ["Lightning", "ResistElectric", 70],
  ["Nether", "ResistNether", 166],
]);

let SPECIES = null; // { names: {int: name}, wcid: {wcid: int} }
let SPECIES_PROMISE = null;

async function readJson(url) {
  if (url.startsWith("file:") && typeof window === "undefined") {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(new URL(url), "utf8"));
  }
  const r = await fetch(url);
  return r.ok ? r.json() : null;
}

/** C11 lazy loader for creature_species.json; idempotent, never rejects. */
export function loadCreatureSpecies() {
  if (SPECIES) return Promise.resolve();
  if (!SPECIES_PROMISE) {
    const url = new URL("../data/creature_species.json", import.meta.url).href;
    SPECIES_PROMISE = readJson(url)
      .then((t) => {
        if (t && typeof t === "object" && t.names && t.wcid) SPECIES = { names: t.names, wcid: t.wcid };
        else SPECIES_PROMISE = null;
      })
      .catch(() => {
        SPECIES_PROMISE = null;
      });
  }
  return SPECIES_PROMISE.then(() => undefined);
}

export function isSpeciesLoaded() {
  return SPECIES !== null;
}

/** CreatureType int → display name ("Drudge", "Phyntos Wasp"); null before load / unknown. */
export function creatureTypeName(ct) {
  if (!SPECIES) return null;
  const n = Number(ct);
  if (!Number.isInteger(n) || n <= 0) return null;
  return SPECIES.names[String(n)] ?? null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readAppraisal(appraisal) {
  const out = { ct: null, maxHp: null, resists: null };
  if (!appraisal || typeof appraisal !== "object") return out;
  const props = appraisal.properties || {};
  const ints = props.ints || {};
  const ct = num(ints.CreatureType ?? ints["2"]);
  if (ct !== null && ct > 0) out.ct = ct;
  const prof = appraisal.creatureProfile || appraisal.failedCreatureProfile || null;
  const hm = prof ? num(prof.health_max ?? prof.healthMax) : null;
  if (hm !== null && hm > 0) out.maxHp = hm;
  const floats = props.floats || {};
  const res = {};
  let any = false;
  for (const [el, name, id] of RESIST_PROPS) {
    const v = num(floats[name] ?? floats[String(id)]);
    if (v !== null) {
      res[el] = v;
      any = true;
    }
  }
  if (any) out.resists = res;
  return out;
}

export class CreatureProfiles {
  constructor({ storage = null, now = Date.now, log } = {}) {
    this.storage = storage && typeof storage.getItem === "function" ? storage : null;
    this.now = typeof now === "function" ? now : Date.now;
    this.log = typeof log === "function" ? log : (m) => console.log(`[vt:creatures] ${m}`);
    this._rows = new Map(); // wcid -> { name, ct, maxHp, resists, at } (insertion order = LRU, oldest first)
    this._dirty = false;
    this._lastWrite = 0;
    this._read();
    if (!SPECIES) loadCreatureSpecies(); // lazy offline table (never awaited)
  }

  _read() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(CREATURES_STORAGE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (!o || o.v !== 1 || !Array.isArray(o.rows)) return;
      for (const row of o.rows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const w = Number(row[0]) >>> 0;
        if (!w || !row[1] || typeof row[1] !== "object") continue;
        this._rows.set(w, row[1]);
      }
    } catch (_) {
      /* corrupt record = empty memory */
    }
  }

  /** Persist now if dirty (dispose / pagehide). */
  flush() {
    if (!this.storage || !this._dirty) return;
    try {
      this.storage.setItem(CREATURES_STORAGE_KEY, JSON.stringify({ v: 1, rows: Array.from(this._rows.entries()) }));
      this._dirty = false;
      this._lastWrite = this.now();
    } catch (_) {
      /* quota: keep the in-memory copy */
    }
  }

  _touch(wcid, row) {
    this._rows.delete(wcid);
    this._rows.set(wcid, row);
    while (this._rows.size > LRU_MAX) this._rows.delete(this._rows.keys().next().value);
  }

  /** Learn from an appraisal (INT-2 forwards the `appraised` signal here). */
  noteAppraisal(guid, wcid, name, appraisal) {
    try {
      const w = Number(wcid) >>> 0;
      if (!w) return;
      const a = readAppraisal(appraisal);
      if (a.ct === null && a.maxHp === null && a.resists === null) return;
      const prev = this._rows.get(w) || {};
      const row = {
        name: typeof name === "string" && name ? name : prev.name || "",
        ct: a.ct ?? prev.ct ?? null,
        maxHp: a.maxHp ?? prev.maxHp ?? null,
        resists: a.resists ?? prev.resists ?? null,
        at: this.now(),
      };
      this._touch(w, row);
      this._dirty = true;
      if (this.now() - this._lastWrite >= WRITE_MIN_INTERVAL_MS) this.flush();
    } catch (_) {
      /* never throws */
    }
  }

  maxHp(wcid) {
    const r = this._rows.get(Number(wcid) >>> 0);
    return r && num(r.maxHp) !== null ? r.maxHp : null;
  }

  resists(wcid) {
    const r = this._rows.get(Number(wcid) >>> 0);
    return r && r.resists ? { ...r.resists } : null;
  }

  /**
   * The element this wcid resists least: the HIGHEST damage multiplier (an
   * element the appraisal did not carry counts as ACE's 1.0; a tie prefers a
   * learned value, then ELEMENTS order), restricted to `among` when given.
   * null without learned resists, or when every allowed multiplier is equal
   * (no information). No "> 1" bar: an Ice Golem (Cold 0, Fire 1) must get
   * Fire, not a cold weapon's element. Deliberately NOT C# GetWeakest, which
   * picks the lowest multiplier below 1.0 — the most RESISTED element under
   * ACE's semantics (review guide-5); creaturegetweakest uses this too.
   */
  weakest(wcid, among) {
    const res = this.resists(wcid);
    if (!res) return null;
    const allowed = Array.isArray(among) && among.length ? new Set(among) : null;
    let best = null;
    let bestV = 0;
    let bestKnown = false;
    let lo = Infinity;
    let hi = -Infinity;
    for (const el of ELEMENTS) {
      if (allowed && !allowed.has(el)) continue;
      const known = typeof res[el] === "number";
      const v = known ? res[el] : 1;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (best === null || v > bestV || (v === bestV && known && !bestKnown)) {
        best = el;
        bestV = v;
        bestKnown = known;
      }
    }
    return best !== null && hi > lo ? best : null;
  }

  /** Species display name: learned CreatureType, else the offline table; null when unknown. */
  species(wcid) {
    const w = Number(wcid) >>> 0;
    if (!w) return null;
    const r = this._rows.get(w);
    if (r && r.ct) {
      const n = creatureTypeName(r.ct);
      if (n) return n;
    }
    if (!SPECIES) return null;
    const ct = SPECIES.wcid[String(w)];
    return ct ? creatureTypeName(ct) : null;
  }

  /** Count of learned wcids (status). */
  get size() {
    return this._rows.size;
  }
}
