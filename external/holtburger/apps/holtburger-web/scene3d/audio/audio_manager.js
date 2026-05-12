// Workstream H3 (2026-05-12) — AudioManager: Web Audio API wrapper.
//
// Plays Wave (0x0A) sounds at 3D world positions. Each AC Wave record
// is fetched + decoded once via `fetchWave(did)` → `decodeAudioData`
// and cached as an `AudioBuffer`. Per `play()` call:
//
//   1. Lookup (or schedule decode of) the AudioBuffer for the given did.
//   2. Build an `AudioBufferSourceNode` (one-shot — sources are
//      single-use per Web Audio API spec).
//   3. Wire through a `PannerNode` configured for 3D positional audio
//      (HRTF panning + inverse-square or linear distance falloff).
//   4. Connect to a per-AudioManager master `GainNode` for global
//      volume control.
//   5. `source.start(0)`.
//
// AudioContext creation is gated on the first user gesture (most
// browsers block autoplay) — `init()` defers context creation until
// the user clicks Login / sends a chat / etc. The 3D scene calls
// `audioManager.notifyUserGesture()` from any input handler. Until
// then `play()` is a no-op.
//
// Listener tracking: per rAF tick the scene3d render loop calls
// `audioManager.setListener(cameraWorldPos, cameraQuaternion)`. The
// listener's forward/up vectors are derived from the quaternion so
// PannerNode HRTF panning swings as the player turns.

const DEFAULT_REF_DISTANCE = 6.0;      // meters: at this distance, full volume
const DEFAULT_ROLLOFF_FACTOR = 1.0;    // inverse-square attenuation rate
const DEFAULT_MAX_DISTANCE = 200.0;    // clamp falloff beyond this distance

/**
 * @typedef {object} PlayOpts
 * @property {number} [refDistance]  Override per-call reference distance.
 * @property {number} [rolloffFactor] Override per-call rolloff factor.
 * @property {number} [maxDistance]  Override per-call clamp distance.
 * @property {number} [gain]         Per-call gain multiplier (0..1).
 * @property {boolean} [loop]        Loop the source (default false).
 */

export class AudioManager {
  /**
   * @param {object} opts
   * @param {(did: number) => Promise<{ takeRiffBytes(): Uint8Array, sampleRate: number, numChannels: number, bitsPerSample: number, id: number }>} opts.fetchWave
   *        The wasm-side `fetchWave` export.
   * @param {number} [opts.masterGain=1.0]
   */
  constructor(opts) {
    if (!opts || typeof opts.fetchWave !== "function") {
      throw new Error("AudioManager: opts.fetchWave required");
    }
    this._fetchWave = opts.fetchWave;
    this._masterGainValue = (opts.masterGain ?? 1.0);

    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {GainNode|null} */
    this._master = null;
    /** @type {AudioListener|null} */
    this._listener = null;

    // Decoded-buffer cache: did → Promise<AudioBuffer|null>.
    // Storing the in-flight Promise dedupes concurrent fetches for the
    // same did. A failed decode resolves to null and is cached so we
    // don't retry per play().
    /** @type {Map<number, Promise<AudioBuffer|null>>} */
    this._bufferCache = new Map();

    // Diagnostics (read by capture scripts).
    this.playCount = 0;
    this.skipCount = 0;
    this.lastError = null;
    this._userGestureNotified = false;
  }

  /**
   * Call from any input handler (click, keydown, etc.) to satisfy the
   * browser's autoplay-policy gating. Idempotent — second call is a
   * no-op. Most pages call this once in the first onClick / onKeyDown.
   */
  notifyUserGesture() {
    if (this._userGestureNotified) return;
    this._userGestureNotified = true;
    this._initContext();
  }

  _initContext() {
    if (this._ctx) return;
    if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
      // Server-side / test env. Don't construct; play() will no-op.
      return;
    }
    try {
      // eslint-disable-next-line no-undef
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._master = this._ctx.createGain();
      this._master.gain.value = this._masterGainValue;
      this._master.connect(this._ctx.destination);
      this._listener = this._ctx.listener;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[H3/audio] AudioContext init failed:", e);
      this._ctx = null;
    }
  }

  /**
   * Resume the underlying AudioContext if it was auto-suspended (most
   * browsers do this when no playback has happened for a while).
   * Idempotent + safe across browser variants.
   */
  async resume() {
    if (!this._ctx) {
      this._initContext();
      if (!this._ctx) return;
    }
    if (this._ctx.state === "suspended") {
      try {
        await this._ctx.resume();
      } catch (_) {}
    }
  }

  /**
   * Master volume (0..1). Applied to all sounds.
   */
  setMasterGain(value) {
    this._masterGainValue = Math.max(0.0, Math.min(1.0, value));
    if (this._master) this._master.gain.value = this._masterGainValue;
  }

  /**
   * Listener tracking — called per rAF tick by the scene3d render
   * loop. AC world position passes through directly (AudioContext
   * uses its own coordinate system; we mirror three.js's right-
   * handed Y-up after worldRoot's -π/2 X rotation).
   *
   * @param {{x:number, y:number, z:number}} worldPos
   * @param {{w:number, x:number, y:number, z:number}} [quaternion]
   */
  setListener(worldPos, quaternion) {
    if (!this._listener) return;
    const L = this._listener;
    // Newer browsers: `L.positionX.value = …` is the preferred API.
    // Older browsers: `L.setPosition(x, y, z)`. Try the new API first.
    if (L.positionX && typeof L.positionX.value === "number") {
      L.positionX.value = worldPos.x;
      L.positionY.value = worldPos.y;
      L.positionZ.value = worldPos.z;
    } else if (typeof L.setPosition === "function") {
      L.setPosition(worldPos.x, worldPos.y, worldPos.z);
    }
    if (!quaternion) return;
    // Forward + up vectors from quaternion. AC: +Y is north, +Z is up.
    // After worldRoot's `rotation.x = -π/2`, three.js space has +Y up,
    // +X east, -Z forward (north). For the AudioContext listener we
    // mirror the three.js orientation since that's what the camera's
    // quaternion is in.
    const { w, x, y, z } = quaternion;
    // Forward = (0,0,-1) rotated by q
    const fx = -2 * (x * z + w * y);
    const fy = -2 * (y * z - w * x);
    const fz = -(1 - 2 * (x * x + y * y));
    // Up = (0,1,0) rotated by q
    const ux = 2 * (x * y - w * z);
    const uy = 1 - 2 * (x * x + z * z);
    const uz = 2 * (y * z + w * x);
    if (L.forwardX && typeof L.forwardX.value === "number") {
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else if (typeof L.setOrientation === "function") {
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /**
   * Fetch + decode a Wave (or return cached AudioBuffer). Returns null
   * on failure. Subsequent calls for the same did return the cached
   * promise.
   *
   * @param {number} did
   * @returns {Promise<AudioBuffer|null>}
   */
  async _loadBuffer(did) {
    const key = (did >>> 0);
    if (this._bufferCache.has(key)) {
      return this._bufferCache.get(key);
    }
    if (!this._ctx) {
      this._initContext();
      if (!this._ctx) return null;
    }
    const promise = (async () => {
      let wave;
      try {
        wave = await this._fetchWave(key);
      } catch (e) {
        this.lastError = String(e?.message ?? e);
        // eslint-disable-next-line no-console
        console.warn(`[H3/audio] fetchWave(0x${key.toString(16)}) failed:`, e);
        return null;
      }
      let bytes;
      try {
        bytes = wave.takeRiffBytes();
      } catch (e) {
        this.lastError = String(e?.message ?? e);
        return null;
      }
      if (!bytes || bytes.length === 0) {
        return null;
      }
      // Take a private ArrayBuffer copy — decodeAudioData detaches its
      // input on some browsers, which would invalidate the wasm-side
      // Uint8Array view.
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      );
      try {
        const buf = await this._ctx.decodeAudioData(ab);
        return buf;
      } catch (e) {
        this.lastError = String(e?.message ?? e);
        // eslint-disable-next-line no-console
        console.warn(
          `[H3/audio] decodeAudioData(0x${key.toString(16)}) failed:`,
          e
        );
        return null;
      }
    })();
    this._bufferCache.set(key, promise);
    return promise;
  }

  /**
   * Play a one-shot positional sound at a world position.
   *
   * Fire-and-forget: returns a Promise<{source, panner, gain}|null>
   * that resolves once the source has STARTED (not finished). Caller
   * can use the returned handle to stop or change volume mid-play.
   *
   * @param {number} did Wave DID (0x0Axxxxxx).
   * @param {{x:number, y:number, z:number}} worldPos
   * @param {PlayOpts} [opts]
   * @returns {Promise<{source: AudioBufferSourceNode, panner: PannerNode, gain: GainNode}|null>}
   */
  async play(did, worldPos, opts = {}) {
    if (!this._ctx) {
      this.skipCount += 1;
      return null;
    }
    if (this._ctx.state === "suspended") {
      // Try to resume; if it fails (e.g. no user gesture yet) skip.
      try {
        await this._ctx.resume();
      } catch (_) {
        this.skipCount += 1;
        return null;
      }
    }
    const buf = await this._loadBuffer(did);
    if (!buf) {
      this.skipCount += 1;
      return null;
    }
    const source = this._ctx.createBufferSource();
    source.buffer = buf;
    source.loop = !!opts.loop;

    const panner = this._ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = opts.refDistance ?? DEFAULT_REF_DISTANCE;
    panner.rolloffFactor = opts.rolloffFactor ?? DEFAULT_ROLLOFF_FACTOR;
    panner.maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
    if (panner.positionX && typeof panner.positionX.value === "number") {
      panner.positionX.value = worldPos.x;
      panner.positionY.value = worldPos.y;
      panner.positionZ.value = worldPos.z;
    } else if (typeof panner.setPosition === "function") {
      panner.setPosition(worldPos.x, worldPos.y, worldPos.z);
    }

    const gain = this._ctx.createGain();
    gain.gain.value = (opts.gain ?? 1.0);

    source.connect(gain).connect(panner).connect(this._master);
    try {
      source.start(0);
      this.playCount += 1;
      return { source, panner, gain };
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      this.skipCount += 1;
      // eslint-disable-next-line no-console
      console.warn("[H3/audio] source.start threw:", e);
      return null;
    }
  }

  /**
   * Stop all currently-active sources by suspending the context.
   * Resumes on next user gesture / explicit resume() call.
   */
  pauseAll() {
    if (!this._ctx) return;
    try { this._ctx.suspend(); } catch (_) {}
  }

  /**
   * Test / diagnostics: clear the decode cache. New play() calls will
   * re-fetch + re-decode. Useful when capture scripts want to measure
   * cold-load behavior or after a setting that affects decode.
   */
  clearCache() {
    this._bufferCache.clear();
  }

  dispose() {
    this.pauseAll();
    this._bufferCache.clear();
    this._ctx = null;
    this._master = null;
    this._listener = null;
  }
}
