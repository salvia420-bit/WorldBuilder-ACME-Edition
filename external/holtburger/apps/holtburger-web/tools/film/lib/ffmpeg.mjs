// tools/film/lib/ffmpeg.mjs — ffmpeg/ffprobe for the film CLI: resolution, a bounded process runner, the take
// mux argv, encoder/demuxer discovery (`film doctor`) and an ffprobe frame count.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) records takes in the page with WebCodecs and drains the encoded
// bytes to the laptop (lib/drain.mjs). ffmpeg then wraps them into playable files without re-encoding when it
// can: Annex-B H.264 → mp4 by stream copy; VP9 in IVF → mp4 via libx264 (crf 14) or → webm by stream copy; a
// JPEG frame sequence → mp4 via libx264. Assembly (plan/edl.mjs) and contact sheets use the same runner. Every
// spawn is injectable (`spawn`) so the tests run a fake ffmpeg script that records its argv — never the real one.
//
// Binary resolution (SPEC §5): --ffmpeg > env FILM_FFMPEG > /home/wbterminal/bin/ffmpeg (static 7.0.2: libx264,
// libvpx-vp9, no VAAPI). ffprobe: --ffprobe > env FILM_FFPROBE > `ffprobe` next to the resolved ffmpeg.

import { spawn as nodeSpawn } from "node:child_process";
import nodeFs from "node:fs";
import path from "node:path";

import { DEFAULT_FFMPEG, resolveFfmpeg } from "./decode_audio.mjs";
import { FilmCliError, EXIT } from "./args.mjs";

export { DEFAULT_FFMPEG, resolveFfmpeg };

/** CRF used when a take must be re-encoded (VP9 → mp4, JPEG frames → mp4): visually lossless. */
export const TAKE_REENCODE_CRF = 14;

/**
 * Video filter for every libx264 re-encode of a take: crop to even dimensions from the top-left corner. libx264
 * with yuv420p refuses an odd width or height ("height not divisible by 2"), and the JPEG frames fallback grabs
 * the canvas at whatever size it has (a window-sized canvas such as 1280×633 when the page was not booted by
 * `film boot`). Same policy as the recorder's own visibleRect for an odd canvas; no resampling, and a no-op on
 * even input.
 */
export const EVEN_CROP_FILTER = "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0";

/**
 * Which ffprobe to run: explicit, else env FILM_FFPROBE, else `ffprobe` beside the ffmpeg binary.
 * @param {string|null|undefined} explicit
 * @param {string} ffmpeg resolved ffmpeg path
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveFfprobe(explicit, ffmpeg, env = process.env) {
  if (explicit) return explicit;
  if (env && env.FILM_FFPROBE) return env.FILM_FFPROBE;
  const dir = path.dirname(ffmpeg || DEFAULT_FFMPEG);
  return dir && dir !== "." ? path.join(dir, "ffprobe") : "ffprobe";
}

/**
 * Run a process to completion, collecting stdout/stderr (each capped). Rejects with FilmCliError exit 2 when the
 * binary cannot be started (ENOENT …) and on timeout; resolves {code, signal, stdout, stderr} otherwise (a
 * non-zero exit is NOT a rejection — callers decide).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{spawn?: typeof nodeSpawn, timeoutMs?: number, maxOutputBytes?: number, what?: string,
 *   onStderr?: (text: string) => void}} [opts]
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, ms: number}>}
 */
export function runProcess(cmd, args, opts = {}) {
  const { spawn = nodeSpawn, timeoutMs = 600_000, maxOutputBytes = 4 << 20, what = path.basename(cmd), onStderr } = opts;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(notFound(what, cmd, e));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      done(new FilmCliError(`${what} timed out after ${Math.round(timeoutMs / 1000)} s`, { exitCode: EXIT.FINDING, code: "PROCESS_TIMEOUT" }));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout?.on("data", (c) => {
      if (stdout.length < maxOutputBytes) stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c) => {
      const t = c.toString("utf8");
      if (stderr.length < maxOutputBytes) stderr += t;
      if (onStderr) {
        try {
          onStderr(t);
        } catch {
          // progress sink errors never stop the process
        }
      }
    });
    child.on("error", (e) => done(notFound(what, cmd, e)));
    child.on("close", (code, signal) => done(null, { code, signal: signal ?? null, stdout, stderr, ms: Date.now() - t0 }));
  });
}

function notFound(what, cmd, e) {
  const hint = e && e.code === "ENOENT" ? " (not found — set FILM_FFMPEG or pass --ffmpeg)" : "";
  return new FilmCliError(`could not run ${what} at ${cmd}${hint}: ${e?.message ?? e}`, {
    exitCode: EXIT.USAGE,
    code: e?.code === "ENOENT" ? "NOT_FOUND" : "SPAWN_FAILED",
  });
}

/**
 * Run ffmpeg and require exit 0; a failure becomes FilmCliError exit 1 with the stderr tail.
 * @param {string} ffmpeg
 * @param {string[]} argv
 * @param {{spawn?: Function, timeoutMs?: number, what?: string, capped?: boolean}} [opts] capped → run through
 *   `capped-build` (the laptop's cgroup memory jail, ~/CLAUDE.md)
 * @returns {Promise<{code: number, stdout: string, stderr: string, ms: number, cmd: string, argv: string[]}>}
 */
export async function runFfmpeg(ffmpeg, argv, opts = {}) {
  const cmd = opts.capped ? "capped-build" : ffmpeg;
  const args = opts.capped ? [ffmpeg, ...argv] : argv;
  const r = await runProcess(cmd, args, { spawn: opts.spawn, timeoutMs: opts.timeoutMs ?? 3_600_000, what: opts.what ?? "ffmpeg" });
  if (r.code !== 0) {
    const tail = r.stderr.trim().split(/\r?\n/).slice(-12).join("\n");
    throw new FilmCliError(`${opts.what ?? "ffmpeg"} failed (exit ${r.code ?? r.signal})${tail ? `:\n${tail}` : ""}`, {
      exitCode: EXIT.FINDING,
      code: "FFMPEG_FAILED",
    });
  }
  return { ...r, cmd, argv: args };
}

/**
 * ffmpeg argv (without the binary) that turns a drained take into a playable file.
 * - avc:    `-r <fps> -i take.h264 -c copy -movflags +faststart out.mp4` (Annex-B stream copy)
 * - vp9:    `-i take.ivf -vf <even crop> -c:v libx264 -pix_fmt yuv420p -crf 14 -r <fps> -movflags +faststart
 *           out.mp4`; with `container:'webm'`: `-i take.ivf -c copy out.webm`
 * - frames: `-framerate <fps> -start_number 0 -i <dir>/%06d.jpg -vf <even crop> -c:v libx264 -pix_fmt yuv420p
 *           -crf 14 -movflags +faststart out.mp4`
 * <even crop> = EVEN_CROP_FILTER (libx264 yuv420p needs even dimensions; a no-op on an even frame).
 * Every argv starts with `-hide_banner -y`.
 * @param {{kind: 'avc'|'vp9'|'frames', input: string, output: string, fps: number, container?: 'mp4'|'webm',
 *   crf?: number}} o input = the raw file (avc/vp9) or the frames directory
 * @returns {string[]}
 */
export function muxArgv({ kind, input, output, fps, container = "mp4", crf = TAKE_REENCODE_CRF }) {
  if (!(Number.isFinite(fps) && fps > 0)) throw new FilmCliError(`muxArgv: fps must be > 0 (got ${fps})`, { code: "BAD_ARGUMENT" });
  const r = String(fps);
  switch (kind) {
    case "avc":
      return ["-hide_banner", "-y", "-r", r, "-i", input, "-c", "copy", "-movflags", "+faststart", output];
    case "vp9":
      if (container === "webm") return ["-hide_banner", "-y", "-i", input, "-c", "copy", output];
      return ["-hide_banner", "-y", "-i", input, "-vf", EVEN_CROP_FILTER, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf),
        "-r", r, "-movflags", "+faststart", output];
    case "frames":
      return ["-hide_banner", "-y", "-framerate", r, "-start_number", "0", "-i", path.join(input, "%06d.jpg"),
        "-vf", EVEN_CROP_FILTER, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-movflags", "+faststart", output];
    default:
      throw new FilmCliError(`muxArgv: unknown take kind '${kind}' (avc | vp9 | frames)`, { code: "BAD_ARGUMENT" });
  }
}

/**
 * Names listed by `ffmpeg -hide_banner -encoders` / `-decoders` / `-demuxers` / `-muxers`: the second column of
 * every row after the dashed separator line (`------` for codecs, `---` or `--` for formats, depending on the
 * ffmpeg version). Comma-joined names (`mov,mp4,m4a,…`) are split.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseFfmpegList(text) {
  const out = new Set();
  let body = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^\s*-{2,}\s*$/.test(line)) {
      body = true;
      continue;
    }
    if (!body) continue;
    const m = /^\s*\S+\s+(\S+)/.exec(line);
    if (m) for (const n of m[1].split(",")) if (n) out.add(n);
  }
  return out;
}

/**
 * Count the video frames of a file with ffprobe (`-count_packets`); null when ffprobe is unavailable or fails.
 * @param {string} ffprobe
 * @param {string} input
 * @param {{spawn?: Function, fs?: typeof nodeFs, timeoutMs?: number}} [opts]
 * @returns {Promise<number|null>}
 */
export async function ffprobeFrameCount(ffprobe, input, opts = {}) {
  const fs = opts.fs ?? nodeFs;
  if (path.isAbsolute(ffprobe) && !fs.existsSync(ffprobe)) return null;
  try {
    const r = await runProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
      "stream=nb_read_packets", "-of", "csv=p=0", input], { spawn: opts.spawn, timeoutMs: opts.timeoutMs ?? 120_000, what: "ffprobe" });
    if (r.code !== 0) return null;
    const n = parseInt(r.stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
