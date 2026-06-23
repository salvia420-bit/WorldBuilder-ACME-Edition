// BakedAmbientSource (2026-06-23) — per-landblock ambient trigger feed
// for AmbientRuntime, backed by the pre-baked `dist/events/*.events.jsonl`
// files (emitted by the `holtburger-event-bake` crate, `ambient.rs`).
//
// WHY this exists. AmbientRuntime's live path walks the wasm Region
// chain `region.ambientStbForTerrainCode(code, scenePick=0)` — a
// region-GLOBAL `terrain_type → STB` lookup that always picks scene
// index 0, because the per-vertex scene-selection hash
// (`CTerrainDesc::GetScene`) isn't decompiled. The baker, by contrast,
// resolves the REAL `scene_type` from each vertex's terrain word
// (`(word >> 11) & 0x1F`) and records, per `(terrain_type, scene_type)`
// bucket, exactly which of the 81 LB vertices it covers + the STB that
// bucket dereferences to. So the baked feed is strictly MORE faithful:
// it knows the actual STB at the player's vertex, scene_type included.
//
// This loader fetches a landblock's baked file lazily on first ask,
// caches the parsed `ambient` triggers, and serves them synchronously
// to AmbientRuntime keyed by `(lbX, lbY)`. It is fail-soft: a 404 (no
// baked file → no ambient on that LB) or any fetch/parse error caches
// an empty trigger list so a broken endpoint is never re-hammered and
// the runtime simply hears nothing rather than throwing.
//
// File naming mirrors `scene3d/spawns.js` (`../../dist/spawns/0xXXXX…`):
// `<base>/0xXXXX.events.jsonl` where `XXXX = (lbX << 8) | lbY` in
// 4-digit uppercase hex (Holtburg lbX=0xA9, lbY=0xB4 → `0xA9B4`).
// Relative fetch URLs resolve against the document base URI, same as
// spawns.js, so the `../../dist/events/` default works regardless of
// this module's own path depth.

// Mirror of spawns.js SPAWNS_BASE_URL, swapping the leaf dir.
export const EVENTS_BASE_URL = "../../dist/events/";

/**
 * One baked ambient trigger, schema-adapted to the shape
 * AmbientRuntime already consumes from the wasm `AmbientStbJs` /
 * `AmbientSoundDescJs` (camelCase + `isContinuous`).
 *
 * @typedef {object} BakedAmbientTrigger
 * @property {number} stbId        STB SoundTable DID (0x20xxxxxx), parsed to int.
 * @property {number} terrainType  (word >> 2) & 0x1F — diagnostic.
 * @property {number} sceneType    (word >> 11) & 0x1F — diagnostic.
 * @property {number[]} vertexIndices  0..80 LB vertices (raw terrain-array
 *                                 order == runtime `col*9 + row`).
 * @property {Array<{sType:number, volume:number, baseChance:number,
 *                   minRate:number, maxRate:number, isContinuous:boolean}>}
 *           ambientSounds          Adapted AmbientSoundDesc rows.
 */

/**
 * Parse one `*.events.jsonl` body into the ambient triggers
 * AmbientRuntime wants. Non-ambient rows (`physics_script_particle`,
 * future `0xF750` event rows, …) and malformed lines are skipped.
 *
 * @param {string} text  JSONL file body.
 * @returns {BakedAmbientTrigger[]}
 */
export function parseAmbientTriggers(text) {
  const out = [];
  const lines = String(text == null ? "" : text).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const s = lines[i].trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch (_) {
      continue; // tolerate a truncated/partial trailing line
    }
    if (!row || row.source !== "ambient" || row.trigger !== "terrain") continue;

    // stb_id arrives as a "0x20000017" string in the baked files; also
    // accept a raw number defensively.
    let stbId = 0;
    if (typeof row.stb_id === "string") stbId = parseInt(row.stb_id, 16) >>> 0;
    else if (Number.isFinite(row.stb_id)) stbId = row.stb_id >>> 0;

    const vertexIndices = Array.isArray(row.vertex_indices)
      ? row.vertex_indices.map((v) => v | 0)
      : [];
    const ambientSounds = Array.isArray(row.ambient_sounds)
      ? row.ambient_sounds.map(_adaptSound)
      : [];

    out.push({
      stbId,
      terrainType: row.terrain_type | 0,
      sceneType: row.scene_type | 0,
      vertexIndices,
      ambientSounds,
    });
  }
  return out;
}

// Baked snake_case row → runtime camelCase AmbientSoundDesc shape.
// AmbientRuntime reads `.sType / .volume / .baseChance / .minRate /
// .maxRate / .isContinuous` (the same getters the wasm
// AmbientSoundDescJs exposes), so adapt field names here once.
function _adaptSound(s) {
  return {
    sType: s.s_type >>> 0,
    volume: +s.volume,
    baseChance: +s.base_chance,
    minRate: +s.min_rate,
    maxRate: +s.max_rate,
    isContinuous: !!s.continuous,
  };
}

export class BakedAmbientSource {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]    Override the dist/events/ base.
   * @param {(url:string)=>Promise<{ok:boolean,status:number,text:()=>Promise<string>}>}
   *        [opts.fetchImpl]           Injectable fetch (tests pass a stub).
   */
  constructor(opts = {}) {
    this._baseUrl = opts.baseUrl || EVENTS_BASE_URL;
    this._fetch =
      typeof opts.fetchImpl === "function"
        ? opts.fetchImpl
        : typeof fetch !== "undefined"
        ? (url) => fetch(url)
        : null;
    /** @type {Map<number, BakedAmbientTrigger[]>} lbKey16 → triggers (loaded). */
    this._cache = new Map();
    /** @type {Set<number>} lbKey16 currently fetching. */
    this._inflight = new Set();

    // Diagnostics (read by capture scripts / __ambientBaked.stats()).
    this.fetchCount = 0;
    this.lbWithAmbient = 0;
    this.lbEmpty = 0;
    this.lbErrors = 0;
    this.lastError = null;
  }

  /**
   * Synchronous accessor for AmbientRuntime's per-tick call. Returns:
   * - a triggers array (possibly empty) once the LB has been loaded;
   * - `null` while the LB is unfetched / in flight (and kicks off the
   *   async fetch on the first ask). AmbientRuntime treats `null` as a
   *   transient miss and retries next tick.
   *
   * @param {number} lbX 0..254
   * @param {number} lbY 0..254
   * @returns {BakedAmbientTrigger[]|null}
   */
  getTriggersForLb(lbX, lbY) {
    const key = ((((lbX & 0xff) << 8) | (lbY & 0xff)) >>> 0);
    const cached = this._cache.get(key);
    if (cached !== undefined) return cached;
    if (!this._inflight.has(key)) this._beginFetch(key);
    return null;
  }

  _beginFetch(key) {
    const hex = key.toString(16).toUpperCase().padStart(4, "0");
    if (!this._fetch) {
      // No fetch available (non-browser, no stub) — cache empty.
      this._cache.set(key, []);
      this.lbEmpty += 1;
      return;
    }
    this._inflight.add(key);
    this.fetchCount += 1;
    const url = `${this._baseUrl}0x${hex}.events.jsonl`;
    Promise.resolve(this._fetch(url))
      .then((resp) => {
        if (!resp || !resp.ok) {
          // 404 / missing file = "no baked ambient for this LB".
          this._cache.set(key, []);
          this.lbEmpty += 1;
          return null;
        }
        return resp.text();
      })
      .then((text) => {
        if (text == null) return; // already cached [] above
        const triggers = parseAmbientTriggers(text);
        this._cache.set(key, triggers);
        if (triggers.length) this.lbWithAmbient += 1;
        else this.lbEmpty += 1;
      })
      .catch((e) => {
        this.lastError = String(e && e.message ? e.message : e);
        this.lbErrors += 1;
        // Cache empty so a broken endpoint isn't re-hit every tick.
        this._cache.set(key, []);
        // eslint-disable-next-line no-console
        console.warn(`[ambient/baked] fetch failed for LB 0x${hex}:`, e);
      })
      .finally(() => {
        this._inflight.delete(key);
      });
  }

  /** Plain-scalar snapshot for capture scripts. */
  stats() {
    return {
      baseUrl: this._baseUrl,
      cachedLbs: this._cache.size,
      inflight: this._inflight.size,
      fetchCount: this.fetchCount,
      lbWithAmbient: this.lbWithAmbient,
      lbEmpty: this.lbEmpty,
      lbErrors: this.lbErrors,
      lastError: this.lastError,
    };
  }
}
