// tools/film/lib/decode_audio.mjs — decode any audio file to mono Float32 PCM by spawning ffmpeg.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) analyses the song of a music video (`film.mjs song analyze`). The
// analyser (tools/film/audio/analyze.mjs) is pure JS over PCM; this is the one place that touches a codec. ffmpeg
// does the decoding, the down-mix to mono and the resampling to the analysis rate (22050 Hz), streaming raw
// little-endian float32 on stdout, which we collect into a growing buffer:
//   ffmpeg -nostdin -v error -i <abs path> -vn -sn -dn -ac 1 -ar <rate> -f f32le -
// ffmpeg resolution: opts.ffmpeg (the CLI's --ffmpeg) > env FILM_FFMPEG > /home/wbterminal/bin/ffmpeg.
// Failures reject with readable messages (ffmpeg missing, non-zero exit with its stderr text, no audio decoded,
// timeout). `spawnImpl` is injectable so tests can stand in a fake ffmpeg without the real binary.

import { spawn as nodeSpawn } from "node:child_process";
import { endianness } from "node:os";
import { resolve as resolvePath } from "node:path";

/** Default ffmpeg binary (SPEC §5). */
export const DEFAULT_FFMPEG = "/home/wbterminal/bin/ffmpeg";
/** Default decode rate = the analyser's rate (features.mjs ANALYSIS_SAMPLE_RATE). */
export const DEFAULT_DECODE_RATE = 22050;

const STDERR_CAP = 64 * 1024;

/**
 * Which ffmpeg to run: explicit option, else env FILM_FFMPEG, else DEFAULT_FFMPEG.
 * @param {string|undefined|null} [explicit]
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveFfmpeg(explicit, env = process.env) {
  if (explicit) return explicit;
  if (env && env.FILM_FFMPEG) return env.FILM_FFMPEG;
  return DEFAULT_FFMPEG;
}

/**
 * The ffmpeg argument vector used to decode `path` to mono f32le at `sampleRate`.
 * @param {string} path
 * @param {number} sampleRate
 * @returns {string[]}
 */
export function ffmpegDecodeArgs(path, sampleRate) {
  return ["-nostdin", "-v", "error", "-i", resolvePath(path), "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-"];
}

/**
 * Little-endian float32 bytes → Float32Array (a trailing partial sample is dropped).
 * @param {Uint8Array} bytes
 * @param {number} [byteLength] number of valid bytes (default bytes.length)
 * @returns {Float32Array}
 */
export function f32leToFloat32(bytes, byteLength = bytes.length) {
  const n = Math.floor(byteLength / 4);
  const out = new Float32Array(n);
  if (endianness() === "LE") {
    new Uint8Array(out.buffer).set(bytes.subarray(0, n * 4));
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  }
  return out;
}

/**
 * Decodes an audio file to mono float PCM via ffmpeg.
 * @param {string} path audio file (any format ffmpeg reads)
 * @param {{ffmpeg?:string, sampleRate?:number, timeoutMs?:number, env?:Record<string,string|undefined>,
 *   spawnImpl?:typeof nodeSpawn}} [opts]
 * @returns {Promise<{pcm:Float32Array, sampleRate:number, durationSec:number}>}
 */
export function decodeAudioFile(path, opts = {}) {
  const { sampleRate = DEFAULT_DECODE_RATE, timeoutMs = 300000, env = process.env, spawnImpl = nodeSpawn } = opts;
  return new Promise((resolve, reject) => {
    if (typeof path !== "string" || path.length === 0) {
      reject(new TypeError("decodeAudioFile: path must be a non-empty string"));
      return;
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 1000 || sampleRate > 384000) {
      reject(new RangeError(`decodeAudioFile: sampleRate must be an integer in [1000, 384000], got ${sampleRate}`));
      return;
    }
    const ffmpeg = resolveFfmpeg(opts.ffmpeg, env);
    let child;
    try {
      child = spawnImpl(ffmpeg, ffmpegDecodeArgs(path, sampleRate), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`decodeAudioFile: could not start ffmpeg at ${ffmpeg}: ${e?.message ?? e}`));
      return;
    }
    let buf = Buffer.allocUnsafe(1 << 20);
    let len = 0;
    let stderr = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(new Error(`decodeAudioFile: ffmpeg timed out after ${timeoutMs} ms decoding ${path}`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (chunk) => {
      if (len + chunk.length > buf.length) {
        let cap = buf.length;
        while (cap < len + chunk.length) cap *= 2;
        const next = Buffer.allocUnsafe(cap);
        buf.copy(next, 0, 0, len);
        buf = next;
      }
      chunk.copy(buf, len);
      len += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      const hint = e && e.code === "ENOENT" ? " (not found — set FILM_FFMPEG or pass --ffmpeg)" : "";
      finish(new Error(`decodeAudioFile: could not run ffmpeg at ${ffmpeg}${hint}: ${e?.message ?? e}`));
    });
    child.on("close", (code, signal) => {
      const msg = stderr.trim().slice(0, 4000);
      if (code !== 0) {
        finish(new Error(`decodeAudioFile: ffmpeg failed on ${path} (${signal ? `signal ${signal}` : `exit code ${code}`})${msg ? `: ${msg}` : ""}`));
        return;
      }
      const pcm = f32leToFloat32(buf, len);
      if (pcm.length === 0) {
        finish(new Error(`decodeAudioFile: no audio decoded from ${path}${msg ? `: ${msg}` : ""}`));
        return;
      }
      finish(null, { pcm, sampleRate, durationSec: pcm.length / sampleRate });
    });
  });
}
