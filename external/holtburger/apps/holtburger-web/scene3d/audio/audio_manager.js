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

// Phase 0 (2026-06-04) — retail inverse-square attenuation. ref=5/rolloff=2
// with distanceModel "exponential" gives WebAudio gain = (max(d,ref)/ref)^(-rolloff)
// = 25/d^2 for d>=5 (flat unity below). Bit-matches retail GetAttenuation
// (acclient.c:383086-383087, VOL_MIN_DIST_SQ=25=5*5).
const DEFAULT_REF_DISTANCE = 5.0;      // meters: at/below this distance, full volume
const DEFAULT_ROLLOFF_FACTOR = 2.0;    // inverse-SQUARE attenuation rate (retail)
const DEFAULT_MAX_DISTANCE = 200.0;    // clamp falloff beyond this distance

/**
 * @typedef {object} PlayOpts
 * @property {number} [refDistance]  Override per-call reference distance.
 * @property {number} [rolloffFactor] Override per-call rolloff factor.
 * @property {number} [maxDistance]  Override per-call clamp distance.
 * @property {number} [gain]         Per-call gain multiplier (0..1).
 * @property {boolean} [loop]        Loop the source (default false).
 * @property {("effect"|"ambient")} [category] Phase 3 (2026-06-04) — category
 *        master bus to route through. "effect" (default) | "ambient".
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
    // Phase 3 (2026-06-04) — retail category master buses (effect/ambient),
    // each feeding the global master. Created lazily in `_initContext()`.
    /** @type {GainNode|null} */
    this._effectMaster = null;
    /** @type {GainNode|null} */
    this._ambientMaster = null;
    /** @type {AudioListener|null} */
    this._listener = null;

    // Decoded-buffer cache: did → Promise<AudioBuffer|null>.
    // Storing the in-flight Promise dedupes concurrent fetches for the
    // same did. A failed decode resolves to null and is cached so we
    // don't retry per play().
    /** @type {Map<number, Promise<AudioBuffer|null>>} */
    this._bufferCache = new Map();

    // Wave 3 / A4 fix (2026-05-28) — sounds whose source should follow
    // a moving entity. Key = AudioBufferSourceNode (unique per play());
    // value = { panner, guid }. Per-frame `updateFollowingPositions`
    // walks this map and rewrites the panner position from the live
    // entity position so HRTF panning tracks moving NPCs / projectiles
    // instead of locking to the spawn point. Removed in `source.onended`
    // when the sound naturally ends (one-shots) or is stopped (loops).
    /** @type {Map<AudioBufferSourceNode, { panner: PannerNode, guid: number }>} */
    this._followingHandles = new Map();

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
      // Phase 3 (2026-06-04) — retail category master buses. Sounds route
      // through a per-category bus (effect/ambient) into the global master,
      // mirroring retail's effect_sound_volume(@45628) / ambient_sound_volume
      // (@45630) sliders premultiplied before dB (acclient.c:383092-383095).
      // Default gain 1.0 = inaudible/transparent at defaults; setters below
      // expose per-category control. Guard so a re-init doesn't orphan buses.
      if (!this._effectMaster) {
        this._effectMaster = this._ctx.createGain();
        this._effectMaster.gain.value = 1.0;
        this._effectMaster.connect(this._master);
      }
      if (!this._ambientMaster) {
        this._ambientMaster = this._ctx.createGain();
        this._ambientMaster.gain.value = 1.0;
        this._ambientMaster.connect(this._master);
      }
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
   * Phase 3 (2026-06-04) — effect-category bus volume (0..1). Mirrors retail
   * effect_sound_volume (acclient.c:@45628). Routes all `category:"effect"`
   * (the default) sounds. Inaudible/transparent at the 1.0 default.
   */
  setEffectGain(value) {
    const v = Math.max(0.0, Math.min(1.0, value));
    if (this._effectMaster) this._effectMaster.gain.value = v;
  }

  /**
   * Phase 3 (2026-06-04) — ambient-category bus volume (0..1). Mirrors retail
   * ambient_sound_volume (acclient.c:@45630). Routes all `category:"ambient"`
   * sounds (lifecycle-managed by ambient_runtime). Transparent at 1.0 default.
   */
  setAmbientGain(value) {
    const v = Math.max(0.0, Math.min(1.0, value));
    if (this._ambientMaster) this._ambientMaster.gain.value = v;
  }

  /**
   * Wave 3 / A4 — per-rAF position update for follow-mode sounds.
   * Walks `_followingHandles` and rewrites each panner's position from
   * the caller-supplied `lookupPosition(guid) → {x,y,z}|null` callback.
   * Missing entities (despawned mid-sound) get skipped silently — the
   * panner keeps its last known position; the source ends naturally
   * within a few frames for one-shots, or stays at the last known
   * position for loops until something stops it.
   *
   * @param {(guid: number) => {x:number, y:number, z:number}|null|undefined} lookupPosition
   */
  updateFollowingPositions(lookupPosition) {
    if (typeof lookupPosition !== "function") return;
    if (this._followingHandles.size === 0) return;
    for (const { panner, guid } of this._followingHandles.values()) {
      const pos = lookupPosition(guid);
      if (!pos) continue;
      if (panner.positionX && typeof panner.positionX.value === "number") {
        panner.positionX.value = pos.x;
        panner.positionY.value = pos.y;
        panner.positionZ.value = pos.z;
      } else if (typeof panner.setPosition === "function") {
        panner.setPosition(pos.x, pos.y, pos.z);
      }
    }
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
   * Phase 3b (2026-06-05) — quantize a linear gain to the retail integer-dB
   * grid. Retail GetAttenuation computes attenuation = ceil(log2(v5)*6.0206)
   * (acclient.c:383098; 6.0206 = 20*log10(2)) and applies that integer-dB
   * value rather than the raw linear gain. We reproduce the same snap:
   *   dB = ceil(log2(g) * 6.0206)   then   g' = 2^(dB / 6.0206)
   * Edge cases mirror retail's branches:
   *   - g <= 0  -> v5 not > 0.0 -> suppressed/silent (acclient.c:383110) -> 0.
   *   - g >= 1  -> retail clamps v4 > 1.0 to 1.0 (acclient.c:383089); log2(1)=0,
   *               ceil(0)=0, 2^0 = 1 -> unity.
   * Result is within <1 dB of the input and inaudible at the 1.0 default.
   * Static + pure so headless unit tests can assert g' for fixed gains with no
   * AudioContext.
   *
   * @param {number} g Linear gain (typically 0..1).
   * @returns {number} dB-quantized linear gain.
   */
  static _quantizeGainToDb(g) {
    if (!(g > 0)) return 0.0;            // <=0 / NaN -> retail silence branch
    const clamped = g > 1.0 ? 1.0 : g;  // retail v4 > 1.0 clamp
    const dB = Math.ceil(Math.log2(clamped) * 6.0206);
    return Math.pow(2, dB / 6.0206);
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
    // Phase 2 (2026-06-04) — retail -50 dB silence cull (ONE-SHOTS ONLY).
    // Retail computes attenuation = ceil(log2(v5)*6.0206) and drops the sound
    // when it falls below VOL_MIN(-50, @45626) (acclient.c:383098-383108).
    // With our inverse-square v=25/d^2, -50 dB (=10^(-50/20)=0.0031623) is
    // crossed near d=88.9 m: 25/d^2 < 0.0031623 => d > 88.91. Cull here BEFORE
    // _loadBuffer to save the fetch+decode. We do NOT cull loops
    // (opts.loop===true): ambient loops are lifecycle-managed by
    // ambient_runtime and may re-enter range as the listener moves.
    const SILENCE_CUTOFF_DISTANCE = 88.91; // 25/d^2 < 0.0031623 => d > 88.9 m
    if (!opts.loop) {
      const L = this._ctx.listener;
      let lx, ly, lz;
      if (L && L.positionX && typeof L.positionX.value === "number") {
        lx = L.positionX.value; ly = L.positionY.value; lz = L.positionZ.value;
      }
      // If we can't determine the listener position (older setPosition-only
      // browsers, or pre-setListener), SKIP the cull — never throw.
      if (typeof lx === "number" && worldPos) {
        const dx = worldPos.x - lx;
        const dy = worldPos.y - ly;
        const dz = worldPos.z - lz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > SILENCE_CUTOFF_DISTANCE) {
          this.skipCount += 1;
          return null;
        }
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
    // Phase 0 (2026-06-04) — "exponential" gives (max(d,ref)/ref)^(-rolloff);
    // with ref=5/rolloff=2 = 25/d^2 = retail inverse-square (acclient.c:383086).
    panner.distanceModel = "exponential";
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
    // Phase 3b (2026-06-05) — dB-domain ceil quantization. Retail
    // GetAttenuation does not apply the effective gain v5 linearly: it
    // quantizes to integer decibels via attenuation = ceil(log2(v5)*6.0206)
    // (acclient.c:383098), where 6.0206 = 20*log10(2) maps a log2 ratio to dB.
    // Mirror that here by snapping the per-call gain to the same integer-dB
    // grid before handing it to the GainNode. Sub-1dB change, dominated by the
    // Phase 0 curve error and inaudible at the 1.0 default (ceil(0)=0 -> 1.0);
    // implemented for retail faithfulness per FIX-PLAN Phase 3b, not audibility.
    gain.gain.value = AudioManager._quantizeGainToDb(opts.gain ?? 1.0);

    // Phase 3 (2026-06-04) — route through the category master bus
    // (effect default | ambient). Falls back to the global master if the
    // bus is missing (e.g. an older context that predates bus creation).
    const bus = (opts.category === "ambient")
      ? this._ambientMaster
      : this._effectMaster;
    source.connect(gain).connect(panner).connect(bus || this._master);
    // Wave 2 / G1 fix (2026-05-28) — disconnect the chain when the source
    // ends. For one-shots, `onended` fires when the buffer finishes; for
    // loops it fires when the caller calls `source.stop()`. Without this,
    // gain + panner nodes accumulate in the Web Audio graph until GC,
    // which is non-deterministic and can stack hundreds of orphan nodes
    // in long sessions.
    // Wave 3 / A4 fix (2026-05-28) — also drop the follow-mode tracking
    // entry so updateFollowingPositions stops touching a dead panner.
    source.onended = () => {
      try { source.disconnect(); } catch (_) {}
      try { gain.disconnect(); } catch (_) {}
      try { panner.disconnect(); } catch (_) {}
      this._followingHandles.delete(source);
    };
    // Wave 3 / A4 fix (2026-05-28) — register for follow-mode tracking
    // if the caller asked the sound to track a moving entity. The
    // per-rAF `updateFollowingPositions` call will rewrite this panner's
    // position each frame from the entity's current world pose.
    if (opts.followGuid != null && Number.isFinite(opts.followGuid)) {
      this._followingHandles.set(source, {
        panner,
        guid: opts.followGuid >>> 0,
      });
    }
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
    // Phase 3 (2026-06-04) — drop the category bus refs alongside master.
    this._effectMaster = null;
    this._ambientMaster = null;
    this._listener = null;
  }
}
