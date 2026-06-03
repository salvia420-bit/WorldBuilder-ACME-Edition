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
// Weighted-random pick algorithm:
//   - 0 entries → null (caller skips)
//   - 1 entry → return directly (avoids RNG churn — Task A measured
//     4185 entries across 4184 keys, so the average is ~1.0 per key)
//   - N entries, sum of `probability` > 0 → standard "spin a uniform
//     pointer in [0, sum), walk the prefix sums" weighted pick
//   - N entries, all probabilities = 0 → uniform random pick across
//     the entries (rare but legal; the alternative would be silently
//     dropping the call)

const SOUND_TABLE_PREFIX = 0x20;

function isSoundTableDid(did) {
  return ((did >>> 24) & 0xff) === SOUND_TABLE_PREFIX;
}

/**
 * @typedef {object} ResolvedSoundEntry
 * @property {number} waveDid     Wave DID (0x0Axxxxxx) to play.
 * @property {number} priority    AC priority float (currently unused
 *                                JS-side; preserved for future logic).
 * @property {number} probability Per-row probability weight (already
 *                                consumed by the picker; returned so
 *                                callers can log / debug).
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
   *        Optional random source for the weighted pick. Used by tests
   *        to make `resolveSound` deterministic. Must return a float in
   *        [0, 1). Defaults to `Math.random`.
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
   * picked by `probability`-weighted random across the entries
   * attached to `soundEnum` in this SoundTable.
   *
   * Returns `null` if the SoundTable has no entries for `soundEnum`
   * (the common case — most tables only carry a handful of enums) or
   * if the fetch failed.
   *
   * Algorithm:
   *   - 0 entries → null
   *   - 1 entry → return it directly (skip RNG)
   *   - N entries, sum of `probability` > 0 → weighted pick
   *   - N entries, sum == 0 → uniform pick (probabilities all zero is
   *     legal wire data; we don't want to silently drop the call)
   *
   * The returned object is a PLAIN POJO snapshot (NOT the wasm-bindgen
   * `SoundEntryJs` handle) — callers can hold a reference indefinitely
   * without worrying about wasm-side `.free()` semantics. The picked
   * wasm entries are freed before this method returns.
   *
   * @param {number} did SoundTable DID (`0x20xxxxxx`).
   * @param {number} soundEnum AC `Sound` enum value (e.g. `0x46` =
   *        Sound.Ambient1).
   * @returns {Promise<ResolvedSoundEntry|null>}
   */
  async resolveSound(did, soundEnum) {
    const stb = await this.get(did);
    if (!stb) return null;
    const enumU32 = soundEnum >>> 0;
    /** @type {any[]} */
    let entries;
    try {
      entries = stb.entriesForSound(enumU32);
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(
        `[H3/sound-cache] entriesForSound(0x${enumU32
          .toString(16)}) on 0x${(did >>> 0).toString(16)} threw:`,
        e
      );
      return null;
    }
    if (!entries || entries.length === 0) {
      return null;
    }
    let picked;
    if (entries.length === 1) {
      picked = entries[0];
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
      const idx = Math.floor((entries.length - 1) * this._rng());
      picked = entries[Math.min(Math.max(idx, 0), entries.length - 1)];
    }
    // Snapshot to a plain object BEFORE freeing the wasm handles.
    const out = {
      waveDid: picked.waveDid >>> 0,
      priority: +picked.priority,
      probability: +picked.probability,
      volume: +picked.volume,
    };
    // Free every wasm-bindgen entry handle (including `picked`,
    // since the snapshot doesn't reference it anymore). The
    // `SoundTableJs` itself stays cached.
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      if (e && typeof e.free === "function") {
        try { e.free(); } catch (_) {}
      }
    }
    return out;
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
    // Don't clear `pending` — those promises are still in-flight and
    // their `.finally(() => this.pending.delete(key))` will tidy up.
  }
}
