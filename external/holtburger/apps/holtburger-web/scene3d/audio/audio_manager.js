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
import { VoicePool, VOICE_PRIORITY } from "./voice_pool.js";
import {
  mix as retailMix,
  getAttenuation as retailAttenuation,
  linearGain,
  stereoPositionFromPan,
  threeToAc,
  headingFromThreeQuaternion,
} from "./retail_mixer.js";

// 2026-10-05 (audio parity) — two mixes. DEFAULT: the HRTF PannerNode
// path below — owner product call 2026-10-05: keep HRTF where the web client
// is deliberately better than retail's stereo. OPT-IN `?audioRetailPan=on`:
// retail's mix — yaw-only integer pan (StereoPannerNode) + 25/d^2
// integer-dB gain + -50 dB cull, computed once at start
// (scene3d/audio/retail_mixer.js; acclient.c 383079-383118, 383152-383180).
// In BOTH modes every voice goes through retail's 16-slot pool
// (scene3d/audio/voice_pool.js; acclient.c 383004-383067), volume <= 0 is
// silent, and playFromCenter() is the non-positional retail
// PlaySoundFromCenter.
export function readAudioRetailPanFlag() {
  try {
    const search = (typeof location !== "undefined" && location?.search) || "";
    return new URLSearchParams(search).get("audioRetailPan") === "on";
  } catch (_) {
    return false;
  }
}

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
    // HRTF PannerNode mix (default) vs retail's stereo mix (?audioRetailPan=on).
    // `opts.hrtf` overrides the URL flag (tests).
    this._hrtf = (typeof opts.hrtf === "boolean") ? opts.hrtf : !readAudioRetailPanFlag();
    // Category slider values (retail effect_sound_volume / ambient_sound_volume).
    // Retail mode folds them into the dB computation BEFORE the -50 dB cull
    // (acclient.c:383092-383095); HRTF mode applies them on the bus GainNodes.
    this._effectGainValue = 1.0;
    this._ambientGainValue = 1.0;
    // Last listener pose (three.js frame) + its retail compass heading.
    this._listenerPos = null;
    this._listenerHeading = 0;
    // Retail 16-voice pool (acclient.c:383004-383067).
    this.voicePool = new VoicePool();

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
        this._effectMaster.gain.value = this._busGain(this._effectGainValue);
        this._effectMaster.connect(this._master);
      }
      if (!this._ambientMaster) {
        this._ambientMaster = this._ctx.createGain();
        this._ambientMaster.gain.value = this._busGain(this._ambientGainValue);
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
    this._effectGainValue = v;
    if (this._effectMaster) this._effectMaster.gain.value = this._busGain(v);
  }

  // Retail mode: the slider is folded into the per-voice dB (so it also moves
  // the -50 dB audibility edge, as retail's does) and the bus stays at unity.
  // HRTF mode: the bus carries the slider, as before.
  _busGain(v) {
    return this._hrtf ? v : 1.0;
  }

  /**
   * Phase 3 (2026-06-04) — ambient-category bus volume (0..1). Mirrors retail
   * ambient_sound_volume (acclient.c:@45630). Routes all `category:"ambient"`
   * sounds (lifecycle-managed by ambient_runtime). Transparent at 1.0 default.
   */
  setAmbientGain(value) {
    const v = Math.max(0.0, Math.min(1.0, value));
    this._ambientGainValue = v;
    if (this._ambientMaster) this._ambientMaster.gain.value = this._busGain(v);
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
    // Kept even before the AudioContext exists: the retail mix reads it.
    if (worldPos) this._listenerPos = { x: +worldPos.x, y: +worldPos.y, z: +worldPos.z };
    if (quaternion) this._listenerHeading = headingFromThreeQuaternion(quaternion);
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
        const msg = String(e?.message ?? e);
        this.lastError = msg;
        // "record not prefetched" is a known + expected failure mode for
        // optimistic-audio callers that fire sounds outside the boot
        // prefetch set — they handle the null return and stay silent.
        // Logging here floods the console without adding signal.
        if (!msg.includes("not prefetched")) {
          // eslint-disable-next-line no-console
          console.warn(`[H3/audio] fetchWave(0x${key.toString(16)}) failed:`, e);
        }
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
      // Take a private ArrayBuffer copy. `takeRiffBytes()` already returns
      // an OWNED copy (the wasm-bindgen glue `.slice()`s every owned-Vec
      // return out of linear memory) — it is NOT a wasm-memory view. The
      // copy exists because `decodeAudioData` DETACHES its input buffer,
      // which would destroy the caller's array.
      // Use the typed array's `.slice()`, never `bytes.buffer.slice()`:
      // `SharedArrayBuffer.prototype.slice` returns another SAB, and
      // decodeAudioData requires a detachable non-shared buffer, so the
      // buffer-level slice would NOT be an escape hatch under a threaded
      // build. `TypedArray.prototype.slice()` always allocates a fresh
      // non-shared ArrayBuffer (AUDIT-sab-views-2026-07-24 must-fix 4).
      const ab = bytes.slice().buffer;
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
   * Play a one-shot (or looping) positional sound at a world position
   * given in the three.js frame (the frame `setListener` receives).
   *
   * Retail mix (`?audioRetailPan=on`): the per-call `gain` is retail's `volume` argument
   * to GetAttenuation — 25/d^2 beyond 5 m, clamp to 1, times the category
   * slider, integer dB, dropped below -50 dB — and the pan is the retail
   * yaw-only integer pan; both are fixed when the sound starts
   * (acclient.c:383079-383118, 383152-383180). `gain <= 0` is SILENT
   * (retail's `v5 > 0` test, 383096). Default: the HRTF PannerNode path
   * (25/d^2 via the panner, same 88.9 m one-shot cull, volume <= 0 silent).
   *
   * Every voice then competes for one of retail's 16 slots
   * (acclient.c:383004-383067): `opts.priority` defaults to the constant 0
   * every retail voice records, so a 17th concurrent sound is dropped.
   *
   * Fire-and-forget: resolves once the source has STARTED (not finished)
   * with `{source, panner, gain}` (panner = StereoPannerNode in retail mode,
   * PannerNode in HRTF mode, null from the centre), or null when skipped.
   *
   * @param {number} did Wave DID (0x0Axxxxxx).
   * @param {{x:number, y:number, z:number}} worldPos
   * @param {PlayOpts & {priority?: number}} [opts]
   */
  async play(did, worldPos, opts = {}) {
    if (!(await this._ensureRunning())) return null;
    if (this._hrtf) return this._playHrtf(did, worldPos, opts);
    const volume = (typeof opts.gain === "number") ? opts.gain : 1.0;
    const master = (opts.category === "ambient") ? this._ambientGainValue : this._effectGainValue;
    let m;
    if (opts.rolloffFactor === 0 || !this._listenerPos || !worldPos) {
      // Callers that ask for no falloff (the ambient layer plays AT the
      // listener) and calls before the first listener pose mix from the
      // centre: distance 0, pan 0 (retail PlayAmbientSoundFromCenter shape,
      // acclient.c:383559).
      const a = retailAttenuation(0, volume, master);
      m = { play: a.play, decibels: a.decibels, pan: 0 };
    } else {
      m = retailMix(
        threeToAc(this._listenerPos),
        this._listenerHeading,
        threeToAc(worldPos),
        volume,
        master,
      );
    }
    this.lastMix = m;
    // Loops are lifecycle-managed by ambient_runtime / portal_space and are
    // never culled here; a loop that starts inaudible starts at gain 0.
    if (!m.play && !opts.loop) {
      this.skipCount += 1;
      return null;
    }
    return this._startVoice(did, {
      gainValue: m.play ? linearGain(m.decibels) : 0,
      pan: m.pan,
      loop: !!opts.loop,
      category: opts.category,
      priority: opts.priority,
    });
  }

  /**
   * Retail SoundManager::PlaySoundFromCenter (acclient.c:383569-383620):
   * no position, no distance falloff, no pan — `GetAttenuation(0.0, volume)`
   * times the effect slider (ambient slider for `category: "ambient"`),
   * integer dB, silent at or below 0 / under -50 dB. Used for UI sounds,
   * environment-change sounds and the portal whooshes.
   *
   * @param {number} waveDid
   * @param {number} volume  retail `volume` (SoundTable row volume / 1.0)
   * @param {{category?: "effect"|"ambient", loop?: boolean, priority?: number}} [opts]
   */
  async playFromCenter(waveDid, volume, opts = {}) {
    if (!(await this._ensureRunning())) return null;
    const master = (opts.category === "ambient") ? this._ambientGainValue : this._effectGainValue;
    const a = retailAttenuation(0, (typeof volume === "number") ? volume : 1.0, master);
    this.lastMix = { play: a.play, decibels: a.decibels, pan: 0 };
    if (!a.play) {
      this.skipCount += 1;
      return null;
    }
    // In HRTF mode the bus already carries the slider: undo the fold-in.
    const gainValue = this._hrtf
      ? Math.min(1, Math.max(0, volume))
      : linearGain(a.decibels);
    return this._startVoice(waveDid, {
      gainValue,
      pan: null,
      loop: !!opts.loop,
      category: opts.category,
      priority: opts.priority,
    });
  }

  async _ensureRunning() {
    if (!this._ctx) {
      this.skipCount += 1;
      return false;
    }
    if (this._ctx.state === "suspended") {
      // Try to resume; if it fails (e.g. no user gesture yet) skip.
      try {
        await this._ctx.resume();
      } catch (_) {
        this.skipCount += 1;
        return false;
      }
    }
    return true;
  }

  // Shared tail: decode, build source -> gain -> [stereo panner] -> bus,
  // claim a retail voice slot, start. `pan` null = no panner node.
  async _startVoice(did, { gainValue, pan, loop, category, priority, panner: hrtfPanner, followGuid }) {
    const buf = await this._loadBuffer(did);
    if (!buf || !this._ctx) {
      this.skipCount += 1;
      return null;
    }
    const source = this._ctx.createBufferSource();
    source.buffer = buf;
    source.loop = !!loop;
    const gain = this._ctx.createGain();
    gain.gain.value = gainValue;
    let panner = hrtfPanner ?? null;
    if (!panner && pan != null && typeof this._ctx.createStereoPanner === "function") {
      panner = this._ctx.createStereoPanner();
      panner.pan.value = stereoPositionFromPan(pan);
    }
    const bus = (category === "ambient") ? this._ambientMaster : this._effectMaster;
    const out = bus || this._master;
    if (panner) source.connect(gain).connect(panner).connect(out);
    else source.connect(gain).connect(out);

    // Retail 16-voice pool. A stolen voice is stopped (SoundBuf::Stop).
    const token = this.voicePool.claim(
      { stop: () => { try { source.stop(); } catch (_) {} } },
      (typeof priority === "number") ? priority : VOICE_PRIORITY,
    );
    if (!token) {
      try { source.disconnect(); } catch (_) {}
      try { gain.disconnect(); } catch (_) {}
      try { panner?.disconnect(); } catch (_) {}
      this.skipCount += 1;
      this.voiceDropCount = (this.voiceDropCount | 0) + 1;
      return null;
    }
    // Wave 2 / G1 — disconnect the chain when the source ends (one-shots:
    // buffer finished; loops: caller stop()). Also frees the voice slot and
    // drops follow-mode tracking.
    source.onended = () => {
      this.voicePool.release(token);
      try { source.disconnect(); } catch (_) {}
      try { gain.disconnect(); } catch (_) {}
      try { panner?.disconnect(); } catch (_) {}
      this._followingHandles.delete(source);
    };
    // Wave 3 / A4 — follow-mode (HRTF path only: the retail mix is fixed at
    // start, acclient.c:383179, so there is nothing to re-pan).
    if (hrtfPanner && followGuid != null && Number.isFinite(followGuid)) {
      this._followingHandles.set(source, { panner: hrtfPanner, guid: followGuid >>> 0 });
    }
    try {
      source.start(0);
      this.playCount += 1;
      return { source, panner, gain };
    } catch (e) {
      this.voicePool.release(token);
      this._followingHandles.delete(source);
      this.lastError = String(e?.message ?? e);
      this.skipCount += 1;
      // eslint-disable-next-line no-console
      console.warn("[H3/audio] source.start threw:", e);
      return null;
    }
  }

  // HRTF path (the default; `?audioRetailPan=on` selects the retail mix): PannerNode with exponential
  // ref=5/rolloff=2 (= 25/d^2) + the 88.9 m one-shot cull.
  async _playHrtf(did, worldPos, opts) {
    // Phase 2 (2026-06-04) — retail -50 dB silence cull (ONE-SHOTS ONLY):
    // 25/d^2 < 0.0031623 => d > 88.91.
    const SILENCE_CUTOFF_DISTANCE = 88.91;
    if (!opts.loop && !((opts.gain ?? 1.0) > 0)) {
      this.skipCount += 1; // volume <= 0 is silent (acclient.c:383096)
      return null;
    }
    if (!opts.loop) {
      const L = this._ctx.listener;
      let lx, ly, lz;
      if (L && L.positionX && typeof L.positionX.value === "number") {
        lx = L.positionX.value; ly = L.positionY.value; lz = L.positionZ.value;
      }
      if (typeof lx === "number" && worldPos) {
        const dx = worldPos.x - lx;
        const dy = worldPos.y - ly;
        const dz = worldPos.z - lz;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > SILENCE_CUTOFF_DISTANCE) {
          this.skipCount += 1;
          return null;
        }
      }
    }
    const panner = this._ctx.createPanner();
    panner.panningModel = "HRTF";
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
    // Phase 3b — integer-dB snap of the per-call gain (acclient.c:383098).
    return this._startVoice(did, {
      gainValue: AudioManager._quantizeGainToDb(opts.gain ?? 1.0),
      pan: null,
      panner,
      loop: !!opts.loop,
      category: opts.category,
      priority: opts.priority,
      followGuid: opts.followGuid,
    });
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
