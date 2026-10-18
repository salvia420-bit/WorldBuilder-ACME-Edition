// scene3d/film/runtime/recorder.js — the in-page take recorder (SPEC §3 runtime/recorder.js).
//
// WHY: the film camera's frames exist only inside the WebGL canvas for one
// task: the renderer runs with preserveDrawingBuffer=false, Page.captureScreenshot
// returns stale/black WebGL frames on the 1070, and captureStream skips frames
// of an off-screen canvas (recon_capture Q3). So every recorded frame is taken
// SYNCHRONOUSLY inside the frame's postRender hook — `new VideoFrame(canvas,
// {timestamp, duration})` → `VideoEncoder.encode(frame, {keyFrame})` →
// `frame.close()` — and encoded in-page with WebCodecs. The CLI pulls the
// encoded chunks out while the take records (`__film.recorder.drain({maxBytes})`,
// tools/film/lib/drain.mjs) so page memory stays bounded.
//
//   avc     H.264 High@5.1 (`avc1.640033`, then Main@5.1 `avc1.4d0033`) in
//           Annex-B (`avc:{format:'annexb'}`: start codes + in-band SPS/PPS on
//           keyframes) — ffmpeg stream-copies the raw .h264 into an mp4;
//   vp9     `vp09.00.40.08` raw frames — the CLI wraps them in IVF;
//   frames  the last resort: `canvas.toDataURL('image/jpeg', q)` in the same
//           task, one JPEG per frame.
// The codec chain is walked with `VideoEncoder.isConfigSupported` (each codec
// first with hardwareAcceleration 'prefer-hardware', then 'no-preference'), so
// a Chrome without a hardware H.264 encoder still records.
//
// Timestamps are film time: frame k of a take at fps F is stamped
// round(k/F·1e6) µs with duration round(1e6/F); a keyframe every
// keyIntervalSec·F frames. Realtime takes are sampled onto the same k/F grid by
// the take player (a display frame that covers several grid points is grabbed
// once and encoded once per point), so every take is a constant-rate stream
// that the CLI muxes with `-r F`. Backpressure: waitForCapacity() blocks the stepped
// take while the encoder queue (`encodeQueueSize`) or the undrained output
// exceeds its limits.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: canvas, VideoEncoder,
// VideoFrame, timers and the logger are injected (defaults: globalThis); it
// never imports a stateful scene3d module. Deterministic: timestamps come from
// the caller's film time, never from a clock.

import { FilmError } from "../core/errors.js";

/** Default recorder settings (SPEC §3). */
export const RECORDER_DEFAULTS = Object.freeze({
  fps: 30,
  bitrate: 40e6,
  keyIntervalSec: 2,
  /** grab() is refused by hasCapacity() / waited on by waitForCapacity() above this encoder queue. */
  maxQueue: 8,
  /** Undrained encoded bytes above which waitForCapacity() waits for the CLI to drain. */
  maxBufferedBytes: 512 * 1024 * 1024,
  /** JPEG quality of the 'frames' fallback. */
  jpegQuality: 0.92,
  /** Longest single waitForCapacity() (ms) before it gives up and lets the take continue. */
  capacityTimeoutMs: 60000,
  /** Poll interval (ms) of waitForCapacity(). */
  pollMs: 4,
  /** Default drain() payload limit (base64 characters ≈ bytes on the CDP wire). */
  drainMaxBytes: 8 * 1024 * 1024,
});

/** Codec strings the recorder knows. */
export const RECORDER_CODECS = Object.freeze({
  avcHigh: "avc1.640033",
  avcMain: "avc1.4d0033",
  vp9: "vp09.00.40.08",
  frames: "frames",
});

/**
 * Fallback chains per requested codec (SPEC: avc1.640033 → avc1.4d0033 →
 * vp09.00.40.08 → 'frames').
 * @type {Readonly<Record<'avc'|'vp9'|'frames', ReadonlyArray<string>>>}
 */
export const RECORDER_CODEC_CHAINS = Object.freeze({
  avc: Object.freeze([RECORDER_CODECS.avcHigh, RECORDER_CODECS.avcMain, RECORDER_CODECS.vp9, RECORDER_CODECS.frames]),
  vp9: Object.freeze([RECORDER_CODECS.vp9, RECORDER_CODECS.frames]),
  frames: Object.freeze([RECORDER_CODECS.frames]),
});

/** Hardware preferences tried for every encoder codec, in order. */
export const RECORDER_HW_PREFERENCES = Object.freeze(["prefer-hardware", "no-preference"]);

/**
 * Take kind of a codec string: 'avc' (avc1/avc3/h264), 'vp9' (vp09/vp9),
 * 'frames' (frames/jpeg), else null.
 * @param {*} codec
 * @returns {'avc'|'vp9'|'frames'|null}
 */
export function codecKind(codec) {
  const c = String(codec ?? "").trim().toLowerCase();
  if (!c) return null;
  if (c === "avc" || c === "h264" || c.startsWith("avc1") || c.startsWith("avc3")) return "avc";
  if (c === "vp9" || c.startsWith("vp09")) return "vp9";
  if (c === "frames" || c === "jpeg" || c === "jpg") return "frames";
  return null;
}

/**
 * Largest even integer ≤ n, at least 2 (H.264 / VP9 4:2:0 need even sizes);
 * null for a non-finite or non-positive n.
 * @param {*} n
 * @returns {number|null}
 */
export function evenDim(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.max(2, Math.floor(v / 2) * 2);
}

/**
 * Length of the base64 encoding of `n` bytes (padded): 4·⌈n/3⌉.
 * @param {number} n
 * @returns {number}
 */
export function base64Length(n) {
  return n > 0 ? 4 * Math.ceil(n / 3) : 0;
}

/** Uint8Array view of bytes; null for anything else. */
function asBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

/**
 * Portable base64 of bytes: `String.fromCharCode` over 32 KiB slices (no
 * argument-count overflow) + `btoa`. Used when neither Buffer nor
 * Uint8Array.prototype.toBase64 exists.
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer} bytes
 * @returns {string}
 */
export function bytesToBase64Portable(bytes) {
  const u8 = asBytes(bytes);
  if (!u8) throw new TypeError("bytesToBase64Portable: bytes must be a Uint8Array, an ArrayBufferView or an ArrayBuffer");
  if (typeof btoa !== "function") throw new FilmError("bytesToBase64Portable: btoa is unavailable", "FILM_NO_BASE64");
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 0x8000)));
  }
  return btoa(bin);
}

/**
 * Base64 of bytes, the fastest way available: Node `Buffer`, then
 * `Uint8Array.prototype.toBase64`, then the portable chunked path.
 * @param {Uint8Array|ArrayBufferView|ArrayBuffer} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  const u8 = asBytes(bytes);
  if (!u8) throw new TypeError("bytesToBase64: bytes must be a Uint8Array, an ArrayBufferView or an ArrayBuffer");
  const B = globalThis.Buffer;
  if (B && typeof B.from === "function") return B.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
  if (typeof u8.toBase64 === "function") return u8.toBase64();
  return bytesToBase64Portable(u8);
}

/**
 * The VideoEncoder config for a codec string (SPEC §3): `{codec, width,
 * height, bitrate, framerate, latencyMode:'quality', hardwareAcceleration}`
 * plus `avc:{format:'annexb'}` for H.264.
 * @param {string} codec
 * @param {{width:number, height:number, bitrate:number, fps:number, hardwareAcceleration?:string}} o
 * @returns {object}
 */
export function encoderConfig(codec, o) {
  const cfg = {
    codec,
    width: o.width,
    height: o.height,
    bitrate: o.bitrate,
    framerate: o.fps,
    latencyMode: "quality",
    hardwareAcceleration: o.hardwareAcceleration || "prefer-hardware",
  };
  if (codecKind(codec) === "avc") cfg.avc = { format: "annexb" };
  return cfg;
}

/** Message text of anything thrown. */
function msgOf(e) {
  return String(e && e.message ? e.message : e);
}

/**
 * Create the take recorder (SPEC §3).
 *
 * - `start()` → `Promise<{ok, codec, kind, width, height, hardwareAcceleration, fallbacks}>`:
 *   walks the codec chain of `codec` ('avc' | 'vp9' | 'frames'; a full codec string
 *   picks its own chain) with `VideoEncoder.isConfigSupported`, configures the first
 *   supported encoder ('frames' needs `canvas.toDataURL`). Throws FilmError
 *   `FILM_RECORDER_UNAVAILABLE` when nothing works, `FILM_RECORDER_STATE` when started twice.
 * - `grab(filmTimeSec | filmTimesSec[])` → boolean, SYNCHRONOUS (call it inside postRender):
 *   `new VideoFrame(canvas, {timestamp, duration, alpha:'discard'})` → `encode(frame,
 *   {keyFrame})` → `frame.close()`; 'frames' mode queues `canvas.toDataURL('image/jpeg', q)`.
 *   timestamp = round(t·1e6) µs (forced strictly increasing); keyFrame every
 *   round(keyIntervalSec·fps) frames. An array of film times wraps the canvas once
 *   and encodes it once per time (`new VideoFrame(frame, {timestamp})` copies; one
 *   JPEG pushed per time): a held frame of a realtime take on the fps grid
 *   (`heldFrames` counts the copies). false when not recording or on failure.
 * - `hasCapacity()` → boolean: encoder queue ≤ maxQueue and undrained bytes ≤ maxBufferedBytes.
 * - `waitForCapacity({timeoutMs})` → `Promise<{ok, waitedMs, timedOut}>`: waits (polling
 *   `sleep(pollMs)`) until hasCapacity(); gives up after timeoutMs (counted, never throws).
 * - `drain({maxBytes})` → `{chunks:[{seq, b64, timestampUs, key, type, durationUs}], done, stats}`:
 *   oldest chunks first, at least one per call, then as many as fit in maxBytes base64
 *   characters; `done` once the recorder stopped (or failed) and everything was drained.
 * - `stop()` → `Promise<stats>`: flush + close the encoder; idempotent.
 * - `abort(reason)` → stats: close without flushing (chunks already out stay drainable).
 * - `stats()` → JSON-safe counters; `state` getter ('idle'|'starting'|'recording'|'stopping'|
 *   'stopped'|'failed').
 *
 * @param {{canvas:object, fps?:number, width?:number, height?:number, codec?:string,
 *   bitrate?:number, keyIntervalSec?:number, VideoEncoder?:Function, VideoFrame?:Function,
 *   maxQueue?:number, maxBufferedBytes?:number, jpegQuality?:number, capacityTimeoutMs?:number,
 *   pollMs?:number, hardwarePreferences?:string[], sleep?:(ms:number)=>Promise<void>,
 *   now?:()=>number, log?:(entry:object)=>void}} opts
 * @returns {object}
 */
export function createRecorder(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const canvas = o.canvas && typeof o.canvas === "object" ? o.canvas : null;
  if (!canvas) throw new FilmError("createRecorder: a canvas is required", "BAD_ARGUMENT");
  const fps = Number.isFinite(o.fps) && o.fps > 0 && o.fps <= 1000 ? +o.fps : RECORDER_DEFAULTS.fps;
  const bitrate = Number.isFinite(o.bitrate) && o.bitrate > 0 ? Math.round(o.bitrate) : RECORDER_DEFAULTS.bitrate;
  const keyIntervalSec = Number.isFinite(o.keyIntervalSec) && o.keyIntervalSec > 0 ? +o.keyIntervalSec : RECORDER_DEFAULTS.keyIntervalSec;
  const keyEvery = Math.max(1, Math.round(keyIntervalSec * fps));
  const maxQueue = Number.isFinite(o.maxQueue) && o.maxQueue >= 0 ? Math.floor(o.maxQueue) : RECORDER_DEFAULTS.maxQueue;
  const maxBuffered = Number.isFinite(o.maxBufferedBytes) && o.maxBufferedBytes > 0 ? o.maxBufferedBytes : RECORDER_DEFAULTS.maxBufferedBytes;
  const jpegQ = Number.isFinite(o.jpegQuality) && o.jpegQuality > 0 && o.jpegQuality <= 1 ? +o.jpegQuality : RECORDER_DEFAULTS.jpegQuality;
  const capacityTimeoutMs = Number.isFinite(o.capacityTimeoutMs) && o.capacityTimeoutMs >= 0 ? o.capacityTimeoutMs : RECORDER_DEFAULTS.capacityTimeoutMs;
  const pollMs = Number.isFinite(o.pollMs) && o.pollMs >= 0 ? o.pollMs : RECORDER_DEFAULTS.pollMs;
  const hwPrefs = Array.isArray(o.hardwarePreferences) && o.hardwarePreferences.length
    ? o.hardwarePreferences.map(String)
    : RECORDER_HW_PREFERENCES.slice();
  const Encoder = o.VideoEncoder !== undefined ? o.VideoEncoder : globalThis.VideoEncoder;
  const Frame = o.VideoFrame !== undefined ? o.VideoFrame : globalThis.VideoFrame;
  const sleep = typeof o.sleep === "function"
    ? o.sleep
    : (ms) => new Promise((resolve) => {
      if (typeof setTimeout === "function") setTimeout(resolve, Math.max(0, ms));
      else resolve();
    });
  const nowMs = typeof o.now === "function"
    ? o.now
    : () => (typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : 0);
  const requested = typeof o.codec === "string" && o.codec.trim() ? o.codec.trim() : "avc";
  const reqKind = codecKind(requested);
  if (!reqKind) throw new FilmError(`createRecorder: unknown codec ${JSON.stringify(o.codec)} (avc | vp9 | frames)`, "BAD_ARGUMENT");
  // A full codec string (e.g. 'avc1.4d0033') starts the chain of its kind at itself.
  let chain = RECORDER_CODEC_CHAINS[reqKind].slice();
  if (requested !== reqKind && !["h264", "jpeg", "jpg"].includes(requested.toLowerCase())) {
    chain = [requested, ...chain.filter((c) => c !== requested)];
  }
  const emit = (entry) => {
    if (typeof o.log !== "function") return;
    try {
      o.log({ event: "film-recorder", ...entry });
    } catch (_) {
      /* a logger never breaks recording */
    }
  };

  const canvasSize = () => [Number(canvas.width) || 0, Number(canvas.height) || 0];
  const [cw0, ch0] = canvasSize();
  const width = evenDim(o.width) ?? evenDim(cw0);
  const height = evenDim(o.height) ?? evenDim(ch0);

  const st = {
    state: "idle",
    codec: null,
    kind: null,
    hw: null,
    /** @type {object|null} */ encoder: null,
    fallbacks: [],
    errors: [],
    /** @type {Array<{seq:number, bytes:Uint8Array|null, b64:string|null, size:number, timestampUs:number, key:boolean, type:string, durationUs:number|null}>} */
    queue: [],
    seq: 0,
    lastTs: -Infinity,
    stopPromise: null,
    visibleRect: null,
    sizeMismatch: null,
  };
  const c = {
    framesGrabbed: 0,
    grabFailures: 0,
    refusedGrabs: 0,
    chunksOut: 0,
    keyFrames: 0,
    bytesOut: 0,
    bufferedBytes: 0,
    drainedChunks: 0,
    drainedBytes: 0,
    drainCalls: 0,
    maxEncodeQueueSize: 0,
    backpressureWaits: 0,
    backpressureWaitMs: 0,
    capacityTimeouts: 0,
    timestampFixes: 0,
    /** Frames encoded as a re-stamped copy of the previous one (grab with several film times). */
    heldFrames: 0,
  };
  const frameDurUs = Math.round(1e6 / fps);

  function fail(where, e) {
    const message = `${where}: ${msgOf(e)}`;
    st.errors.push(message);
    if (st.errors.length > 32) st.errors.shift();
    if (st.state === "recording" || st.state === "starting" || st.state === "stopping") st.state = "failed";
    emit({ level: "warn", message });
  }

  function encodeQueueSize() {
    const enc = st.encoder;
    const n = enc && Number.isFinite(enc.encodeQueueSize) ? enc.encodeQueueSize : 0;
    if (n > c.maxEncodeQueueSize) c.maxEncodeQueueSize = n;
    return n;
  }

  function pushChunk(rec) {
    st.queue.push(rec);
    c.chunksOut += 1;
    c.bytesOut += rec.size;
    c.bufferedBytes += rec.size;
    if (rec.key) c.keyFrames += 1;
  }

  /** VideoEncoder output callback: copy the chunk bytes out (the chunk is only valid in the callback). */
  function onOutput(chunk) {
    try {
      const n = Number(chunk && chunk.byteLength) || 0;
      const bytes = new Uint8Array(n);
      if (n > 0) chunk.copyTo(bytes);
      const type = chunk && typeof chunk.type === "string" ? chunk.type : "delta";
      pushChunk({
        seq: st.seq++,
        bytes,
        b64: null,
        size: n,
        timestampUs: Number.isFinite(chunk.timestamp) ? chunk.timestamp : null,
        key: type === "key",
        type,
        durationUs: Number.isFinite(chunk.duration) ? chunk.duration : null,
      });
    } catch (e) {
      fail("encoder output", e);
    }
  }

  async function supported(cfg) {
    if (typeof Encoder.isConfigSupported !== "function") return true;
    try {
      const r = await Encoder.isConfigSupported(cfg);
      return !!(r && r.supported === true);
    } catch (e) {
      st.fallbacks.push({ codec: cfg.codec, hardwareAcceleration: cfg.hardwareAcceleration, reason: `isConfigSupported threw: ${msgOf(e)}` });
      return false;
    }
  }

  async function start() {
    if (st.state !== "idle") throw new FilmError(`recorder.start(): already ${st.state}`, "FILM_RECORDER_STATE");
    st.state = "starting";
    if (!width || !height) {
      st.state = "failed";
      throw new FilmError(`recorder: no usable frame size (canvas ${cw0}×${ch0}, requested ${o.width}×${o.height})`, "FILM_RECORDER_UNAVAILABLE");
    }
    for (const codec of chain) {
      if (codecKind(codec) === "frames") {
        if (typeof canvas.toDataURL !== "function") {
          st.fallbacks.push({ codec, reason: "canvas.toDataURL unavailable" });
          continue;
        }
        st.codec = RECORDER_CODECS.frames;
        st.kind = "frames";
        break;
      }
      if (typeof Encoder !== "function") {
        st.fallbacks.push({ codec, reason: "VideoEncoder unavailable" });
        continue;
      }
      if (typeof Frame !== "function") {
        st.fallbacks.push({ codec, reason: "VideoFrame unavailable" });
        continue;
      }
      let done = false;
      for (const hw of hwPrefs) {
        const cfg = encoderConfig(codec, { width, height, bitrate, fps, hardwareAcceleration: hw });
        if (!(await supported(cfg))) {
          st.fallbacks.push({ codec, hardwareAcceleration: hw, reason: "not supported" });
          continue;
        }
        let enc = null;
        try {
          enc = new Encoder({ output: onOutput, error: (e) => fail("encoder error", e) });
          enc.configure(cfg);
        } catch (e) {
          st.fallbacks.push({ codec, hardwareAcceleration: hw, reason: `configure threw: ${msgOf(e)}` });
          try {
            if (enc && typeof enc.close === "function") enc.close();
          } catch (_) {
            /* already closed */
          }
          continue;
        }
        st.encoder = enc;
        st.codec = codec;
        st.kind = codecKind(codec);
        st.hw = hw;
        done = true;
        break;
      }
      if (done) break;
    }
    if (!st.kind) {
      st.state = "failed";
      throw new FilmError(`recorder: no usable codec (tried ${chain.join(" → ")})`, { code: "FILM_RECORDER_UNAVAILABLE", details: { fallbacks: st.fallbacks.slice() } });
    }
    // The canvas a hair larger than the even target (odd sizes): crop instead of scaling.
    const [cw, ch] = canvasSize();
    if (cw !== width || ch !== height) {
      if (cw >= width && ch >= height && cw - width <= 2 && ch - height <= 2) st.visibleRect = { x: 0, y: 0, width, height };
      else st.sizeMismatch = { canvas: [cw, ch], encoder: [width, height] };
    }
    st.state = "recording";
    emit({ message: "start", codec: st.codec, kind: st.kind, width, height, hardwareAcceleration: st.hw });
    return {
      ok: true,
      codec: st.codec,
      kind: st.kind,
      width,
      height,
      hardwareAcceleration: st.hw,
      fallbacks: st.fallbacks.map((f) => ({ ...f })),
    };
  }

  /** The next strictly increasing µs timestamp for film time t (a non-finite t continues the grid). */
  function nextTs(filmTimeSec) {
    const t = Number(filmTimeSec);
    let ts = Number.isFinite(t) ? Math.round(t * 1e6) : (Number.isFinite(st.lastTs) ? st.lastTs + frameDurUs : 0);
    if (!(ts > st.lastTs)) {
      ts = Number.isFinite(st.lastTs) ? st.lastTs + 1 : 0;
      c.timestampFixes += 1;
    }
    return ts;
  }

  /**
   * Record the drawn canvas. `filmTime` is one film time (s), or an array of
   * film times: the canvas is wrapped ONCE and that frame is encoded once per
   * time (a held frame — a realtime take on the fps grid whose display frame
   * covered several grid points). true when every copy was queued.
   */
  function grab(filmTime) {
    if (st.state !== "recording") {
      c.refusedGrabs += 1;
      return false;
    }
    const times = Array.isArray(filmTime) ? filmTime : [filmTime];
    if (times.length === 0) return false;
    if (st.kind === "frames") {
      let url;
      try {
        url = canvas.toDataURL("image/jpeg", jpegQ);
      } catch (e) {
        c.grabFailures += 1;
        fail("toDataURL", e);
        return false;
      }
      const s = typeof url === "string" ? url : "";
      const comma = s.startsWith("data:") ? s.indexOf(",") : -1;
      const b64 = comma >= 0 ? s.slice(comma + 1) : s;
      if (!b64) {
        c.grabFailures += 1;
        return false;
      }
      const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
      times.forEach((tm, j) => {
        const ts = nextTs(tm);
        pushChunk({ seq: st.seq++, bytes: null, b64, size, timestampUs: ts, key: true, type: "key", durationUs: frameDurUs });
        st.lastTs = ts;
        c.framesGrabbed += 1;
        if (j > 0) c.heldFrames += 1;
      });
      return true;
    }
    let frame = null;
    try {
      const ts0 = nextTs(times[0]);
      const init = { timestamp: ts0, duration: frameDurUs, alpha: "discard" };
      if (st.visibleRect) init.visibleRect = st.visibleRect;
      frame = new Frame(canvas, init);
      st.encoder.encode(frame, { keyFrame: c.framesGrabbed % keyEvery === 0 });
      st.lastTs = ts0;
      c.framesGrabbed += 1;
      for (let j = 1; j < times.length; j += 1) {
        // The same pixels, re-stamped: a VideoFrame built from a VideoFrame shares its resource.
        const ts = nextTs(times[j]);
        const copy = new Frame(frame, { timestamp: ts, duration: frameDurUs });
        try {
          st.encoder.encode(copy, { keyFrame: c.framesGrabbed % keyEvery === 0 });
        } finally {
          if (copy && typeof copy.close === "function") {
            try {
              copy.close();
            } catch (_) {
              /* already closed */
            }
          }
        }
        st.lastTs = ts;
        c.framesGrabbed += 1;
        c.heldFrames += 1;
      }
      encodeQueueSize();
      return true;
    } catch (e) {
      c.grabFailures += 1;
      fail("grab", e);
      return false;
    } finally {
      if (frame && typeof frame.close === "function") {
        try {
          frame.close();
        } catch (_) {
          /* already closed */
        }
      }
    }
  }

  function hasCapacity() {
    return encodeQueueSize() <= maxQueue && c.bufferedBytes <= maxBuffered;
  }

  async function waitForCapacity(wopts = {}) {
    const w = wopts && typeof wopts === "object" ? wopts : {};
    const limit = Number.isFinite(w.timeoutMs) && w.timeoutMs >= 0 ? w.timeoutMs : capacityTimeoutMs;
    if (hasCapacity() || st.state !== "recording") return { ok: true, waitedMs: 0, timedOut: false };
    c.backpressureWaits += 1;
    const t0 = nowMs();
    // A poll budget as well as the clock, so a frozen injected clock can never hang the take.
    const maxPolls = pollMs > 0 ? Math.ceil(limit / pollMs) + 1 : 100000;
    let polls = 0;
    for (;;) {
      await sleep(pollMs);
      polls += 1;
      const waited = Math.max(0, nowMs() - t0);
      if (hasCapacity() || st.state !== "recording") {
        c.backpressureWaitMs += waited;
        return { ok: true, waitedMs: waited, timedOut: false };
      }
      if (waited >= limit || polls >= maxPolls) {
        c.backpressureWaitMs += waited;
        c.capacityTimeouts += 1;
        emit({ level: "warn", message: `waitForCapacity gave up after ${Math.round(waited)} ms (queue ${encodeQueueSize()}, buffered ${c.bufferedBytes} B)` });
        return { ok: false, waitedMs: waited, timedOut: true };
      }
    }
  }

  function finished() {
    return st.state === "stopped" || st.state === "failed";
  }

  function drain(dopts = {}) {
    const d = dopts && typeof dopts === "object" ? dopts : {};
    const maxBytes = Number.isFinite(d.maxBytes) && d.maxBytes > 0 ? d.maxBytes : RECORDER_DEFAULTS.drainMaxBytes;
    c.drainCalls += 1;
    const chunks = [];
    let total = 0;
    while (st.queue.length > 0) {
      const rec = st.queue[0];
      const len = rec.b64 !== null ? rec.b64.length : base64Length(rec.size);
      if (chunks.length > 0 && total + len > maxBytes) break;
      st.queue.shift();
      const b64 = rec.b64 !== null ? rec.b64 : bytesToBase64(rec.bytes);
      total += b64.length;
      c.bufferedBytes = Math.max(0, c.bufferedBytes - rec.size);
      c.drainedChunks += 1;
      c.drainedBytes += rec.size;
      const out = { seq: rec.seq, b64, timestampUs: rec.timestampUs, key: rec.key, type: rec.type };
      if (rec.durationUs !== null) out.durationUs = rec.durationUs;
      chunks.push(out);
    }
    return { chunks, done: finished() && st.queue.length === 0, stats: stats() };
  }

  function closeEncoder() {
    const enc = st.encoder;
    st.encoder = null;
    if (enc && typeof enc.close === "function" && enc.state !== "closed") {
      try {
        enc.close();
      } catch (_) {
        /* already closed */
      }
    }
  }

  function stop() {
    if (st.stopPromise) return st.stopPromise;
    st.stopPromise = (async () => {
      if (st.state === "idle" || st.state === "starting") {
        st.state = "stopped";
        return stats();
      }
      if (st.state === "recording") st.state = "stopping";
      const enc = st.encoder;
      if (enc && st.state === "stopping" && typeof enc.flush === "function") {
        try {
          await enc.flush();
        } catch (e) {
          fail("flush", e);
        }
      }
      closeEncoder();
      if (st.state !== "failed") st.state = "stopped";
      emit({ message: "stop", framesGrabbed: c.framesGrabbed, chunksOut: c.chunksOut });
      return stats();
    })();
    return st.stopPromise;
  }

  function abort(reason) {
    if (!finished()) {
      if (reason !== undefined) st.errors.push(`aborted: ${msgOf(reason)}`);
      st.state = reason !== undefined ? "failed" : "stopped";
      if (!st.stopPromise) st.stopPromise = Promise.resolve(null).then(() => stats());
    }
    // Also after a grab / output failure: fail() leaves the (hardware) encoder configured.
    closeEncoder();
    return stats();
  }

  function stats() {
    const [cw, ch] = canvasSize();
    return {
      state: st.state,
      requested,
      codec: st.codec,
      kind: st.kind,
      hardwareAcceleration: st.hw,
      width,
      height,
      fps,
      bitrate,
      keyIntervalSec,
      keyEvery,
      canvas: { width: cw, height: ch },
      visibleRect: st.visibleRect ? { ...st.visibleRect } : null,
      sizeMismatch: st.sizeMismatch ? { canvas: st.sizeMismatch.canvas.slice(), encoder: st.sizeMismatch.encoder.slice() } : null,
      ...c,
      encodeQueueSize: encodeQueueSize(),
      queuedChunks: st.queue.length,
      lastTimestampUs: Number.isFinite(st.lastTs) ? st.lastTs : null,
      fallbacks: st.fallbacks.map((f) => ({ ...f })),
      errors: st.errors.slice(),
    };
  }

  return {
    start,
    grab,
    hasCapacity,
    waitForCapacity,
    drain,
    stop,
    abort,
    stats,
    get state() {
      return st.state;
    },
    get codec() {
      return st.codec;
    },
    get kind() {
      return st.kind;
    },
  };
}
