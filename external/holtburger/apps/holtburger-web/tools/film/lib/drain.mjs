// tools/film/lib/drain.mjs — pull a take's encoded video out of the page while it records, and write it to disk.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) encodes every take in the page with WebCodecs
// (scene3d/film/runtime/recorder.js, SPEC §3) because preserveDrawingBuffer is false and per-frame screenshots
// are unreliable for WebGL. The encoded chunks wait in the page until the CLI fetches them with
// `window.__film.recorder.drain({maxBytes})` → `{chunks:[{seq, b64, timestampUs, key}], done, stats}`. The CLI
// drains CONCURRENTLY with `__film.shoot(…)`, so page memory stays bounded on long takes, and writes:
//   avc    → <name>.h264   raw Annex-B bytes, concatenated exactly as encoded (ffmpeg stream-copies them to mp4)
//   vp9    → <name>.ivf    an IVF container written here: 32-byte file header + 12-byte header per frame
//   frames → <name>.frames/000000.jpg …   one JPEG per chunk (the page's toDataURL fallback)
// The recorder may fall back (avc1 → vp09 → frames) when the 1070's Chrome rejects a config, so the sink sniffs
// the first chunk (Annex-B start code / JPEG SOI / otherwise VP9) unless the drain reports the codec.
//
// IVF layout (little endian), as written by libvpx:
//   file header  0 'DKIF' · 4 u16 version 0 · 6 u16 header size 32 · 8 fourcc 'VP90' · 12 u16 width ·
//                14 u16 height · 16 u32 timebase denominator (= fps) · 20 u32 timebase numerator (= 1) ·
//                24 u32 frame count (patched on close) · 28 u32 unused 0
//   frame header 0 u32 frame size · 4 u64 pts (frame index = round(timestampUs·fps/1e6), forced strictly increasing)
//
// Node-only; fs injectable.

import nodeFs from "node:fs";
import path from "node:path";

import { FilmCliError, EXIT } from "./args.mjs";

/** Default maxBytes per drain call (SPEC: 8 MiB keeps each CDP response small). */
export const DRAIN_MAX_BYTES = 8 << 20;
/** IVF file header size. */
export const IVF_HEADER_BYTES = 32;
/** IVF per-frame header size. */
export const IVF_FRAME_HEADER_BYTES = 12;
/** Take kinds the sink writes. */
export const TAKE_KINDS = Object.freeze(["avc", "vp9", "frames"]);

/**
 * The IVF file header.
 * @param {{width: number, height: number, fps: number, frames?: number, fourcc?: string}} o
 * @returns {Buffer} 32 bytes
 */
export function ivfFileHeader({ width, height, fps, frames = 0, fourcc = "VP90" }) {
  const b = Buffer.alloc(IVF_HEADER_BYTES);
  b.write("DKIF", 0, "ascii");
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(IVF_HEADER_BYTES, 6);
  b.write(String(fourcc).padEnd(4, " ").slice(0, 4), 8, "ascii");
  b.writeUInt16LE(width & 0xffff, 12);
  b.writeUInt16LE(height & 0xffff, 14);
  const { rate, scale } = ivfTimebase(fps);
  b.writeUInt32LE(rate >>> 0, 16);
  b.writeUInt32LE(scale >>> 0, 20);
  b.writeUInt32LE(frames >>> 0, 24);
  b.writeUInt32LE(0, 28);
  return b;
}

/**
 * IVF timebase for a frame rate: integer fps → {rate: fps, scale: 1}; fractional (29.97) → {rate: fps·1000,
 * scale: 1000} rounded.
 * @param {number} fps
 * @returns {{rate: number, scale: number}}
 */
export function ivfTimebase(fps) {
  if (!(Number.isFinite(fps) && fps > 0)) throw new FilmCliError(`IVF needs fps > 0 (got ${fps})`, { code: "BAD_ARGUMENT" });
  if (Number.isInteger(fps)) return { rate: fps, scale: 1 };
  return { rate: Math.round(fps * 1000), scale: 1000 };
}

/**
 * The 12-byte IVF frame header.
 * @param {number} size frame payload bytes
 * @param {number} pts in timebase units
 * @returns {Buffer}
 */
export function ivfFrameHeader(size, pts) {
  const b = Buffer.alloc(IVF_FRAME_HEADER_BYTES);
  b.writeUInt32LE(size >>> 0, 0);
  b.writeBigUInt64LE(BigInt(Math.max(0, Math.round(pts))), 4);
  return b;
}

/**
 * Chunk payload → bytes. Accepts plain base64 or a `data:…;base64,` URL (the frames fallback).
 * @param {{b64?: string, data?: string}} chunk
 * @returns {Buffer}
 */
export function chunkBytes(chunk) {
  let s = typeof chunk?.b64 === "string" ? chunk.b64 : typeof chunk?.data === "string" ? chunk.data : "";
  const comma = s.startsWith("data:") ? s.indexOf(",") : -1;
  if (comma >= 0) s = s.slice(comma + 1);
  return Buffer.from(s, "base64");
}

/**
 * What a chunk's bytes are: Annex-B H.264 (00 00 01 / 00 00 00 01 start code), JPEG (FF D8 FF) or, otherwise,
 * a raw VP9 frame.
 * @param {Uint8Array} bytes
 * @returns {'avc'|'frames'|'vp9'}
 */
export function sniffChunkKind(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "frames";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && ((bytes[2] === 1) || (bytes[2] === 0 && bytes[3] === 1))) return "avc";
  return "vp9";
}

/**
 * Codec string from the page (recorder stats / status) → take kind; null when unknown.
 * @param {unknown} codec e.g. 'avc1.640033', 'vp09.00.40.08', 'frames', 'avc', 'vp9'
 * @returns {'avc'|'vp9'|'frames'|null}
 */
export function kindOfCodec(codec) {
  const c = String(codec ?? "").toLowerCase();
  if (!c) return null;
  if (c === "avc" || c.startsWith("avc1") || c.startsWith("avc3") || c === "h264") return "avc";
  if (c === "vp9" || c.startsWith("vp09") || c === "vp9-ivf") return "vp9";
  if (c === "frames" || c === "jpeg" || c === "jpg") return "frames";
  return null;
}

/**
 * The raw file (or directory) a take kind is drained into.
 * @param {string} dir takes directory
 * @param {string} name file stem (shot id, or `<shot>.retake<k>`)
 * @param {'avc'|'vp9'|'frames'} kind
 * @returns {string}
 */
export function rawPathFor(dir, name, kind) {
  if (kind === "avc") return path.join(dir, `${name}.h264`);
  if (kind === "vp9") return path.join(dir, `${name}.ivf`);
  if (kind === "frames") return path.join(dir, `${name}.frames`);
  throw new FilmCliError(`unknown take kind '${kind}'`, { code: "BAD_ARGUMENT" });
}

/**
 * A streaming writer for one take. The kind is fixed by `codec` ('avc' | 'vp9' | 'frames'), or picked on the
 * first chunk when `codec` is 'auto' (stats.codec of the drain result wins over sniffing). Chunks are written in
 * `seq` order; repeated seqs are dropped and gaps counted.
 * @param {{dir: string, name: string, codec?: 'auto'|'avc'|'vp9'|'frames', fps: number, width: number,
 *   height: number, fs?: typeof nodeFs}} o
 * @returns {{write: (chunks: object[], stats?: object) => number, close: () => object, readonly kind: string|null,
 *   readonly path: string|null}}
 */
export function createTakeSink({ dir, name, codec = "auto", fps, width, height, fs = nodeFs }) {
  if (codec !== "auto" && !TAKE_KINDS.includes(codec)) throw new FilmCliError(`unknown codec '${codec}' (avc | vp9 | frames)`, { code: "BAD_ARGUMENT" });
  let kind = codec === "auto" ? null : codec;
  let file = null;
  let fd = null;
  let frames = 0;
  let bytes = 0;
  let keyFrames = 0;
  let lastSeq = null;
  let seqGaps = 0;
  let duplicates = 0;
  let firstTimestampUs = null;
  let lastTimestampUs = null;
  let lastPts = -1;
  let requested = codec;
  let closed = false;

  function open(k) {
    kind = k;
    file = rawPathFor(dir, name, k);
    fs.mkdirSync(dir, { recursive: true });
    if (k === "frames") {
      fs.rmSync(file, { recursive: true, force: true });
      fs.mkdirSync(file, { recursive: true });
      return;
    }
    fd = fs.openSync(file, "w");
    if (k === "vp9") {
      // Sequential write (no position): a positional pwrite would NOT advance the file offset, and the first
      // frame header would land on top of this one. Only the frame-count patch in close() is positional.
      const h = ivfFileHeader({ width, height, fps });
      fs.writeSync(fd, h, 0, h.length);
      bytes += h.length;
    }
  }

  function writeOne(c) {
    const data = chunkBytes(c);
    if (kind === null) {
      // The drain did not name the codec: trust the bytes.
      open(sniffChunkKind(data));
    }
    const ts = Number(c?.timestampUs);
    if (Number.isFinite(ts)) {
      if (firstTimestampUs === null) firstTimestampUs = ts;
      lastTimestampUs = ts;
    }
    if (c?.key === true || c?.type === "key") keyFrames++;
    if (kind === "avc") {
      fs.writeSync(fd, data, 0, data.length);
      bytes += data.length;
    } else if (kind === "vp9") {
      let pts = Number.isFinite(ts) ? Math.round((ts * ivfTimebase(fps).rate) / (1e6 * ivfTimebase(fps).scale)) : frames;
      if (pts <= lastPts) pts = lastPts + 1;
      lastPts = pts;
      const h = ivfFrameHeader(data.length, pts);
      fs.writeSync(fd, h, 0, h.length);
      fs.writeSync(fd, data, 0, data.length);
      bytes += h.length + data.length;
    } else {
      const f = path.join(file, `${String(frames).padStart(6, "0")}.jpg`);
      fs.writeFileSync(f, data);
      bytes += data.length;
    }
    frames++;
  }

  return {
    get kind() {
      return kind;
    },
    get path() {
      return file;
    },
    /**
     * Write one drain batch. Returns the number of frames written from it.
     * @param {Array<{seq?: number, b64: string, timestampUs?: number, key?: boolean}>} chunks
     * @param {{codec?: string}} [stats] drain stats (stats.codec picks the kind before the first write)
     */
    write(chunks, stats) {
      if (closed) throw new FilmCliError("take sink is closed", { code: "SINK_CLOSED" });
      if (kind === null && fd === null) {
        const named = kindOfCodec(stats?.codec);
        if (named) open(named);
      }
      const list = (Array.isArray(chunks) ? chunks : []).slice();
      list.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
      let n = 0;
      for (const c of list) {
        const seq = Number(c?.seq);
        if (Number.isFinite(seq)) {
          if (lastSeq !== null && seq <= lastSeq) {
            duplicates++;
            continue;
          }
          if (lastSeq !== null && seq > lastSeq + 1) seqGaps += seq - lastSeq - 1;
          lastSeq = seq;
        }
        writeOne(c);
        n++;
      }
      return n;
    },
    /**
     * Finish the file (patches the IVF frame count) and return its stats.
     * @returns {{kind: string|null, requested: string, path: string|null, frames: number, bytes: number,
     *   keyFrames: number, seqGaps: number, duplicates: number, firstTimestampUs: number|null,
     *   lastTimestampUs: number|null}}
     */
    close() {
      if (!closed) {
        closed = true;
        if (fd !== null) {
          if (kind === "vp9") {
            const cnt = Buffer.alloc(4);
            cnt.writeUInt32LE(frames >>> 0, 0);
            fs.writeSync(fd, cnt, 0, 4, 24);
          }
          fs.closeSync(fd);
          fd = null;
        }
      }
      return { kind, requested, path: file, frames, bytes, keyFrames, seqGaps, duplicates, firstTimestampUs, lastTimestampUs };
    },
  };
}

/**
 * Drain the page recorder into `sink` while `shootPromise` (the in-flight `__film.shoot(…)` evaluate) runs.
 * Loop: `drain({maxBytes})` → write chunks → stop on `done`; sleep `pollMs` when a call returned nothing. After
 * shoot settles the loop keeps draining until `done`, but gives up (FilmCliError exit 1) when nothing arrives for
 * `idleTimeoutMs`. A rejected shoot stops the loop after one more drain and is re-thrown.
 * @param {{drain: (opts: {maxBytes: number}) => Promise<{chunks?: object[], done?: boolean, stats?: object}>,
 *   sink: ReturnType<typeof createTakeSink>, shootPromise: Promise<unknown>, maxBytes?: number, pollMs?: number,
 *   idleTimeoutMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   onProgress?: (p: {frames: number, bytes: number, polls: number}) => void}} o
 * @returns {Promise<{shootResult: unknown, polls: number, chunks: number, lastStats: object|null}>}
 */
export async function drainTake(o) {
  const { drain, sink, shootPromise, maxBytes = DRAIN_MAX_BYTES, pollMs = 200, idleTimeoutMs = 60_000, onProgress } = o;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let shootDone = false;
  let shootResult;
  let shootError = null;
  const settled = Promise.resolve(shootPromise).then(
    (r) => {
      shootDone = true;
      shootResult = r;
    },
    (e) => {
      shootDone = true;
      shootError = e ?? new Error("shoot failed");
    },
  );
  let polls = 0;
  let chunks = 0;
  let lastStats = null;
  let lastProgressAt = now();
  let finalAfterError = false;
  for (;;) {
    const r = await drain({ maxBytes });
    polls++;
    const list = Array.isArray(r?.chunks) ? r.chunks : [];
    if (r?.stats) lastStats = r.stats;
    if (list.length) {
      chunks += sink.write(list, r?.stats);
      lastProgressAt = now();
      if (onProgress) {
        try {
          onProgress({ frames: chunks, bytes: 0, polls });
        } catch {
          // progress output never stops a take
        }
      }
    }
    if (r?.done === true) break;
    if (shootDone && shootError) {
      if (finalAfterError) break;
      finalAfterError = true;
      continue;
    }
    if (shootDone && now() - lastProgressAt > idleTimeoutMs) {
      throw new FilmCliError(`the recorder never reported done (${Math.round(idleTimeoutMs / 1000)} s without data after the take ended)`, {
        exitCode: EXIT.FINDING,
        code: "DRAIN_STALLED",
      });
    }
    if (!list.length) await sleep(pollMs);
  }
  await settled;
  if (shootError) throw shootError;
  return { shootResult, polls, chunks, lastStats };
}
