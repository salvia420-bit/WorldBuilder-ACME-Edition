// audio-1 part 2 (2026-10-13) — WavePrefetchQueue, the retail CreateSound
// analogue. OPT-IN `?wavePrefetch=on`.
//
// Retail loads every wave a sound table names when the table itself loads.
// SoundTableData::UnPack (acclient.c:385399) calls SoundManager::CreateSound
// (:383707) for each variant whose sound_id_ is non-zero (:385486-385488).
// SoundManager::GetSound (:383433) then only looks the wave up in
// sound_hash_, so a retail sound never waits on a load. Holtburger fetched
// each wave on its first play, which is why the first hit, footstep or chime
// of a session could arrive late. This queue fetches a newly installed
// table's waves in the background (SoundTableCache `onInstall`), so a later
// play finds the record already resident in the wasm shard cache.
//
// Bytes only. Each wave goes through `fetchWave(did)` with no urgent
// argument, which is the wasm NORMAL lane. The returned WaveJs is freed at
// once and never decoded, so the AudioManager's decoded-buffer LRU is not
// touched. The guards come from the audit verifier:
//   - Nothing starts before scene-ready, so a cold boot streams terrain
//     first. The check reads `__sceneReadyEverFired`, the order-safe latch
//     index.html sets with `__bootState === "ready"`. 'in-world' can
//     overwrite that scalar, so the latch is read instead.
//   - At most 2 fetches are in flight.
//   - A per-session byte budget (default 8 MiB) caps the queue. The shard
//     cache is unbounded by default (manifest_source.rs
//     configured_shard_budget_bytes), so every prefetched wave stays
//     resident.
//   - Each wave DID is queued at most once per instance.
// It stays opt-in until a cold-boot A/B shows no streaming regression.
// Same approach as WebAC packages/renderer/src/audio/WavePrefetch.ts
// (AGPL-3.0); the guards above are ours.

export const WAVE_PREFETCH_MAX_IN_FLIGHT = 2;
export const WAVE_PREFETCH_BYTE_BUDGET = 8 * 1024 * 1024;
const WAVE_PREFIX = 0x0a;
const READY_POLL_MS = 1000;

/**
 * `?wavePrefetch=on` (default OFF — only the exact value "on" enables it).
 * @param {string} [search]
 * @returns {boolean}
 */
export function wavePrefetchEnabled(search) {
  try {
    return new URLSearchParams(search ?? globalThis.location?.search ?? "").get("wavePrefetch") === "on";
  } catch (_) {
    return false;
  }
}

/**
 * Scene-ready gate. Reads the `__sceneReadyEverFired` latch, or
 * `__bootState === "ready"` for a host that only sets the scalar.
 * @param {any} [g]
 * @returns {boolean}
 */
export function sceneReadyLatched(g = globalThis) {
  return g?.__sceneReadyEverFired === true || g?.__bootState === "ready";
}

function isWaveDid(did) {
  return (did >>> 24) === WAVE_PREFIX;
}

/**
 * The distinct Wave DIDs (0x0Axxxxxx, sorted) a `SoundTableJs` names. It
 * prefers the wasm `waveIds()` (audio-1). On an older pkg without it, it
 * walks `soundKeys()` + `entriesForSound()` and frees every entry handle.
 * A throwing table yields whatever was collected.
 * @param {any} stb
 * @returns {number[]}
 */
export function soundTableWaveIds(stb) {
  const out = new Set();
  const add = (d) => {
    const did = d >>> 0;
    if (isWaveDid(did)) out.add(did);
  };
  if (!stb) return [];
  try {
    if (typeof stb.waveIds === "function") {
      for (const d of stb.waveIds()) add(d);
    } else if (typeof stb.soundKeys === "function" && typeof stb.entriesForSound === "function") {
      for (const k of stb.soundKeys()) {
        const list = stb.entriesForSound(k >>> 0) || [];
        for (let i = 0; i < list.length; i += 1) {
          const e = list[i];
          if (!e) continue;
          add(e.waveDid);
          if (typeof e.free === "function") {
            try { e.free(); } catch (_) {}
          }
        }
      }
    }
  } catch (_) { /* keep what was collected */ }
  return [...out].sort((a, b) => a - b);
}

export class WavePrefetchQueue {
  /**
   * @param {object} opts
   * @param {(did: number) => Promise<any>} opts.fetchWave
   *        Normal-lane wave fetch (the wasm `fetchWave` called with ONE
   *        argument). The result's `riffByteLength` counts toward the budget,
   *        and the handle is freed.
   * @param {() => boolean} [opts.isReady] Scene-ready gate (default
   *        `sceneReadyLatched()`).
   * @param {number} [opts.maxInFlight=2]
   * @param {number} [opts.byteBudget=8 MiB]
   * @param {(fn: () => void, ms: number) => any} [opts.setTimeout] Re-check
   *        timer while waiting for scene-ready (tests inject one).
   * @param {number} [opts.pollMs=1000]
   */
  constructor(opts) {
    if (!opts || typeof opts.fetchWave !== "function") {
      throw new Error("WavePrefetchQueue: opts.fetchWave required");
    }
    this._fetchWave = opts.fetchWave;
    this._isReady = typeof opts.isReady === "function" ? opts.isReady : () => sceneReadyLatched();
    this._maxInFlight = Math.max(1, Math.floor(opts.maxInFlight ?? WAVE_PREFETCH_MAX_IN_FLIGHT));
    this._byteBudget = Number.isFinite(opts.byteBudget) && opts.byteBudget >= 0
      ? opts.byteBudget
      : WAVE_PREFETCH_BYTE_BUDGET;
    this._setTimeout = typeof opts.setTimeout === "function"
      ? opts.setTimeout
      : (fn, ms) => setTimeout(fn, ms);
    this._pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : READY_POLL_MS;
    /** @type {Set<number>} every wave DID ever queued (per instance) */
    this._seen = new Set();
    /** @type {number[]} FIFO of wave DIDs not yet started */
    this._queue = [];
    this._pollArmed = false;
    this._disposed = false;

    // Diagnostics (`stats()`).
    this.tables = 0;
    this.inFlight = 0;
    this.maxInFlightSeen = 0;
    this.fetched = 0;
    this.failed = 0;
    this.dropped = 0;
    this.bytes = 0;
    this.capped = false;
  }

  /**
   * Queue a newly installed table's waves. Use it as the SoundTableCache
   * `onInstall` hook.
   * @param {any} stb SoundTableJs
   * @returns {number} how many waves were newly queued
   */
  enqueueTable(stb) {
    this.tables += 1;
    return this.enqueue(soundTableWaveIds(stb));
  }

  /**
   * Queue wave DIDs. Non-Wave DIDs and DIDs already seen are skipped. Once
   * the budget is spent, new DIDs are counted as dropped.
   * @param {Iterable<number>} waveIds
   * @returns {number}
   */
  enqueue(waveIds) {
    if (this._disposed || !waveIds) return 0;
    let added = 0;
    for (const d of waveIds) {
      const did = d >>> 0;
      if (!isWaveDid(did) || this._seen.has(did)) continue;
      this._seen.add(did);
      if (this.capped) {
        this.dropped += 1;
        continue;
      }
      this._queue.push(did);
      added += 1;
    }
    if (added > 0) this._pump();
    return added;
  }

  _pump() {
    if (this._disposed || this._queue.length === 0) return;
    if (!this._isReady()) {
      this._armReadyPoll();
      return;
    }
    while (this.inFlight < this._maxInFlight && this._queue.length > 0) {
      if (this.bytes >= this._byteBudget) {
        this._cap();
        return;
      }
      const did = this._queue.shift();
      this.inFlight += 1;
      if (this.inFlight > this.maxInFlightSeen) this.maxInFlightSeen = this.inFlight;
      this._fetchOne(did);
    }
  }

  async _fetchOne(did) {
    let size = 0;
    try {
      const wave = await this._fetchWave(did);
      if (wave) {
        size = Number(wave.riffByteLength) || 0;
        if (typeof wave.free === "function") {
          try { wave.free(); } catch (_) {}
        }
      }
      this.fetched += 1;
    } catch (_) {
      // A miss here only means the wave loads on its first play, as before.
      this.failed += 1;
    } finally {
      this.inFlight -= 1;
      this.bytes += size;
      this._pump();
    }
  }

  _cap() {
    this.capped = true;
    this.dropped += this._queue.length;
    this._queue.length = 0;
  }

  _armReadyPoll() {
    if (this._pollArmed) return;
    this._pollArmed = true;
    this._setTimeout(() => {
      this._pollArmed = false;
      this._pump();
    }, this._pollMs);
  }

  /** Plain-scalar snapshot (safe to JSON.stringify). */
  stats() {
    return {
      tables: this.tables,
      seen: this._seen.size,
      queued: this._queue.length,
      inFlight: this.inFlight,
      maxInFlightSeen: this.maxInFlightSeen,
      fetched: this.fetched,
      failed: this.failed,
      dropped: this.dropped,
      bytes: this.bytes,
      byteBudget: this._byteBudget,
      capped: this.capped,
      ready: !!this._isReady(),
    };
  }

  /** Stop: drop the queue. In-flight fetches finish and are freed. */
  dispose() {
    this._disposed = true;
    this._queue.length = 0;
  }
}

/**
 * Build the queue only under `?wavePrefetch=on`, and return null otherwise
 * (the default). The scene3d wiring passes the result's `enqueueTable` as
 * the SoundTableCache `onInstall` hook.
 * @param {object} opts WavePrefetchQueue options plus `search`.
 * @returns {WavePrefetchQueue|null}
 */
export function createWavePrefetch(opts) {
  if (!wavePrefetchEnabled(opts?.search)) return null;
  if (!opts || typeof opts.fetchWave !== "function") return null;
  return new WavePrefetchQueue(opts);
}
