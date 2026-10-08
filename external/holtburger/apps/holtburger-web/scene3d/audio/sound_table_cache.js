// Task C (ambient-sounds-chain, 2026-05-12) — SoundTableCache.
//
// Per-DID memoization layer around the wasm `fetchSoundTable` export.
// Three downstream consumers want SoundTable rows resolved into Wave
// DIDs at runtime, all keyed by `0x20xxxxxx` SoundTable DID:
//
//   - Task D (ambient_runtime.js): per-tick Region-driven ambient roll.
//     Resolves `(stb_id, Sound.AmbientN)` to a Wave each timer fire.
//   - Task E (entities.js AnimationHook executor): per-entity idle
//     animation hooks fire `(SoundTable_did, Sound enum)` pairs.
//   - Task F (ACE GameMessageSound handler): server-pushed sound on a
//     specific entity GUID.
//
// All three want the same shape: `(did, soundEnum) → SoundEntry | null`.
// That's the `resolveSound` method below. The cache also exposes `get`
// (returns the raw `SoundTableJs` handle for callers that need
// `soundKeys()` or want to walk multiple enums on the same table) and
// `preload` (bulk warm).
//
// Concurrency model mirrors `scene3d/materials.js::MaterialCache`:
//
//   - `cached: Map<did, SoundTableJs>` — fully-resolved entries.
//   - `pending: Map<did, Promise<SoundTableJs|null>>` — in-flight
//     wasm fetches. Two callers awaiting `get(0x20000081)` at the same
//     time share one fetch (and one parse) by latching on the same
//     Promise. On resolution we install into `cached` and clear from
//     `pending`. On failure we clear from `pending` so a retry works.
//
// The cache does NOT poison-cache failures — a transient network
// blip shouldn't lock out a SoundTable forever. `cached` stores only
// successful resolves; failures fall through and the next `get()` will
// re-issue the fetch.
//
// Selection (UNIFORM) pick algorithm:
//   - 0 entries → null (caller skips)
//   - 1 entry → return directly (avoids RNG churn — Task A measured
//     4185 entries across 4184 keys, so the average is ~1.0 per key)
//   - N entries → UNIFORM pick `floor((N-1) * rng())` across the
//     entries, bit-faithful to retail `SoundManager::GetSound`
//     (acclient.c:383446-383450; chorizite SoundManager.cs:90-97).
//     `probability` is NOT a selection weight — it gates a SEPARATE
//     PlayProbability roll at the playback call site (the consumer's
//     `rng() < probability` check), independent of which entry is chosen.
//
// 2026-06-05 (item W2.1 / D-2, audio-fidelity-deep-2026-06-04 FIX-PLAN):
//   Rewrote this header (and the @property/@param/resolveSound prose
//   below) to describe the uniform pick. The earlier text described a
//   removed `probability`-weighted prefix-sum picker — that was a
//   divergence from retail GetSound and the live code at `resolveSound`
//   already does the uniform pick. Doc-only sync; no behavior change.
//
// audio-5 (2026-10-08 round 2) — row memo. `resolveSound` used to cross
// the wasm boundary on EVERY play: `entriesForSound` clones the Vec and
// hands back N fresh `SoundEntryJs` wrappers (4 getter calls on the pick,
// then N frees through the FinalizationRegistry) for data that never
// changes — every footstep, server sound and UI click. Retail
// SoundManager::GetSound (acclient.c:383433) is a lookup into the resident
// table that copies four fields to the stack. Now each (did, enum) is read
// once into frozen plain rows (`_rows`, empty for an enum the table lacks)
// and the pick runs on those. The pick itself is unchanged.

const SOUND_TABLE_PREFIX = 0x20;

function isSoundTableDid(did) {
  return ((did >>> 24) & 0xff) === SOUND_TABLE_PREFIX;
}

/**
 * @typedef {object} ResolvedSoundEntry
 * @property {number} waveDid     Wave DID (0x0Axxxxxx) to play.
 * @property {number} priority    AC priority float (currently unused
 *                                JS-side; preserved for future logic).
 * @property {number} probability Per-row PlayProbability gate (0..1).
 *                                NOT consumed by the selection pick
 *                                (which is uniform — see
 *                                resolveSound); returned so the caller
 *                                can roll its own `rng() < probability`
 *                                playback gate (retail PlayProbability,
 *                                acclient.c:383507) and/or log/debug.
 * @property {number} volume      Per-row volume multiplier (0..1).
 */

export class SoundTableCache {
  /**
   * @param {object} opts
   * @param {(did: number) => Promise<any>} opts.fetchSoundTable
   *        The wasm-side `fetchSoundTable` export. Receives a u32 DID,
   *        returns a Promise resolving to a `SoundTableJs` handle with
   *        `id`, `hashKey`, `numHashes`, `numSounds` getters plus
   *        `soundKeys()` and `entriesForSound(soundEnum)` methods.
   * @param {object} [opts.rng]
   *        Optional random source for the uniform selection pick. Used
   *        by tests to make `resolveSound` deterministic. Must return a
   *        float in [0, 1). Defaults to `Math.random`.
   * @param {boolean} [opts.warnOnBadDid=true]
   *        If true, log a one-shot `console.warn` the first time a
   *        non-0x20-prefixed DID is passed in. Defaults to true.
   */
  constructor(opts) {
    if (!opts || typeof opts.fetchSoundTable !== "function") {
      throw new Error("SoundTableCache: opts.fetchSoundTable required");
    }
    this._fetchSoundTable = opts.fetchSoundTable;
    this._rng = typeof opts.rng === "function" ? opts.rng : Math.random;
    this._warnOnBadDid = opts.warnOnBadDid !== false;
    this._badDidWarned = false;

    /** @type {Map<number, any>} did → SoundTableJs */
    this.cached = new Map();
    /** @type {Map<number, Promise<any|null>>} did → in-flight fetch */
    this.pending = new Map();
    /** @type {Map<number, Map<number, ReadonlyArray<ResolvedSoundEntry>>>}
     *  did → soundEnum → frozen plain rows (audio-5) */
    this._rows = new Map();

    // Diagnostics — read by capture scripts via `cache.stats()`.
    this.hitCount = 0;
    this.missCount = 0;
    this.errorCount = 0;
    this.lastError = null;
  }

  /**
   * Get (and cache) a `SoundTableJs` for `did`. Returns the cached
   * handle on a hit, the shared in-flight promise on a concurrent
   * miss, or kicks a fresh wasm fetch otherwise.
   *
   * Returns `null` (with a one-shot warn) for non-0x20-prefixed DIDs
   * — callers should never reach this code path, but it's better to
   * fail loudly than to fire a doomed wasm fetch.
   *
   * Wasm failures clear the `pending` entry so a retry can re-fetch
   * (no poison-caching). Returns `null` on failure.
   *
   * @param {number} did
   * @returns {Promise<any|null>} SoundTableJs handle or null
   */
  async get(did) {
    const key = (did >>> 0);
    if (!isSoundTableDid(key)) {
      if (this._warnOnBadDid && !this._badDidWarned) {
        this._badDidWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[H3/sound-cache] non-SoundTable DID 0x${key
            .toString(16)
            .padStart(8, "0")} — expected prefix 0x20. Returning null.`
        );
      }
      return null;
    }
    const hit = this.cached.get(key);
    if (hit) {
      this.hitCount += 1;
      return hit;
    }
    const inflight = this.pending.get(key);
    if (inflight) {
      // Another caller is already fetching — share the Promise.
      // (Doesn't bump hit/miss; the in-flight resolution will.)
      return inflight;
    }
    this.missCount += 1;
    const promise = (async () => {
      let stb;
      try {
        stb = await this._fetchSoundTable(key);
      } catch (e) {
        this.errorCount += 1;
        this.lastError = String(e?.message ?? e);
        // eslint-disable-next-line no-console
        console.warn(
          `[H3/sound-cache] fetchSoundTable(0x${key
            .toString(16)
            .padStart(8, "0")}) failed:`,
          e
        );
        return null;
      }
      if (!stb) {
        // Unexpected — wasm returned a falsy SoundTableJs. Treat as
        // a soft error so callers see null.
        this.errorCount += 1;
        return null;
      }
      this.cached.set(key, stb);
      return stb;
    })();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Resolve a (soundTableDid, soundEnum) pair to one `SoundEntry`,
   * picked by UNIFORM random across the entries attached to `soundEnum`
   * in this SoundTable. `probability` is NOT a selection weight (it
   * gates a separate PlayProbability roll at the call site).
   *
   * Returns `null` if the SoundTable has no entries for `soundEnum`
   * (the common case — most tables only carry a handful of enums) or
   * if the fetch failed.
   *
   * Algorithm (retail GetSound — UNIFORM pick; `probability` is NOT a
   * selection weight: it gates a separate playback roll at the call site):
   *   - 0 entries → null
   *   - 1 entry → return it directly (skip RNG)
   *   - N entries → uniform pick `floor((N-1) * rng())`, bit-faithful to
   *     retail GetSound (see the selection site below). The previous
   *     probability-weighted prefix-sum was a divergence.
   *
   * The returned object is a PLAIN POJO snapshot (NOT the wasm-bindgen
   * `SoundEntryJs` handle) — callers can hold a reference indefinitely
   * without worrying about wasm-side `.free()` semantics. The wasm entries
   * are read once per (did, enum) and freed at once (audio-5 `_rowsFor`).
   *
   * @param {number} did SoundTable DID (`0x20xxxxxx`).
   * @param {number} soundEnum AC `Sound` enum value (e.g. `0x46` =
   *        Sound.Ambient1).
   * @returns {Promise<ResolvedSoundEntry|null>}
   */
  async resolveSound(did, soundEnum) {
    const stb = await this.get(did);
    if (!stb) return null;
    const rows = this._rowsFor(did >>> 0, soundEnum >>> 0, stb);
    if (!rows || rows.length === 0) {
      return null;
    }
    let picked;
    if (rows.length === 1) {
      picked = rows[0];
    } else {
      // followup (2026-06-03): retail GetSound (acclient.c:383446-383450) picks a
      // UNIFORM index `(uint64)((num-1) * RollDice(0,1))` over the entries and does
      // NOT weight selection by `probability_` — that field gates a separate roll
      // at playback, it is not a selection weight. The previous probability-
      // weighted prefix-sum was a divergence; match retail's uniform pick.
      // NOTE: `this._rng()` is JS [0,1) where retail RollDice is inclusive (0,1].
      // This only negligibly under-weights the last entry (within retail's own
      // quirk territory) and is intentionally left bit-faithful to GetSound — do
      // NOT "fix" the half-open vs inclusive range here.
      const idx = Math.floor((rows.length - 1) * this._rng());
      picked = rows[Math.min(Math.max(idx, 0), rows.length - 1)];
    }
    // A caller's own copy: the cached row stays untouched.
    return { ...picked };
  }

  /**
   * audio-5 — the plain rows for (did, soundEnum), read from the wasm table
   * once and memoized (an enum the table lacks memoizes as an empty list).
   * Every wasm-bindgen `SoundEntryJs` handle is freed right after the
   * snapshot. A throwing `entriesForSound` is not memoized (so it retries).
   * @returns {ReadonlyArray<ResolvedSoundEntry>|null}
   */
  _rowsFor(did, enumU32, stb) {
    let byEnum = this._rows.get(did);
    const hit = byEnum?.get(enumU32);
    if (hit) return hit;
    /** @type {any[]} */
    let entries;
    try {
      entries = stb.entriesForSound(enumU32);
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(
        `[H3/sound-cache] entriesForSound(0x${enumU32
          .toString(16)}) on 0x${did.toString(16)} threw:`,
        e
      );
      return null;
    }
    const rows = [];
    const list = entries || [];
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      if (!e) continue;
      // Snapshot to a plain object BEFORE freeing the wasm handle.
      rows.push(Object.freeze({
        waveDid: e.waveDid >>> 0,
        priority: +e.priority,
        probability: +e.probability,
        volume: +e.volume,
      }));
      if (typeof e.free === "function") {
        try { e.free(); } catch (_) {}
      }
    }
    const frozen = Object.freeze(rows);
    if (!byEnum) {
      byEnum = new Map();
      this._rows.set(did, byEnum);
    }
    byEnum.set(enumU32, frozen);
    return frozen;
  }

  /**
   * Bulk-warm the cache. Calls `get(did)` for each entry in `dids`,
   * catching per-DID failures so one bad DID doesn't tank the batch.
   *
   * Returns once every fetch (success or failure) has settled. Failed
   * DIDs are NOT installed in `cached` — a subsequent `get()` will
   * retry. The promise itself never rejects.
   *
   * @param {Iterable<number>} dids
   * @returns {Promise<void>}
   */
  async preload(dids) {
    if (!dids) return;
    const tasks = [];
    for (const did of dids) {
      tasks.push(
        this.get(did >>> 0).catch((e) => {
          // get() already logs + clears pending; swallow here so
          // Promise.all doesn't reject on the first failure.
          this.lastError = String(e?.message ?? e);
          return null;
        })
      );
    }
    if (tasks.length === 0) return;
    await Promise.all(tasks);
  }

  /**
   * Diagnostic snapshot — used by capture scripts to verify cache
   * state without poking the internal maps. Returns plain scalars
   * (safe to JSON.stringify).
   *
   * @returns {{cached: number, pending: number, total: number,
   *           hits: number, misses: number, errors: number,
   *           lastError: string|null}}
   */
  stats() {
    return {
      cached: this.cached.size,
      pending: this.pending.size,
      total: this.cached.size + this.pending.size,
      hits: this.hitCount,
      misses: this.missCount,
      errors: this.errorCount,
      lastError: this.lastError,
    };
  }

  /**
   * Drop every cached SoundTable. Wasm-side handles get freed so the
   * Rust-side memory is reclaimed; in-flight fetches are NOT
   * cancelled (no abort plumbing in `fetchSoundTable`). Safe to call
   * multiple times.
   */
  dispose() {
    for (const stb of this.cached.values()) {
      if (stb && typeof stb.free === "function") {
        try { stb.free(); } catch (_) {}
      }
    }
    this.cached.clear();
    this._rows.clear();
    // Don't clear `pending` — those promises are still in-flight and
    // their `.finally(() => this.pending.delete(key))` will tidy up.
  }
}
