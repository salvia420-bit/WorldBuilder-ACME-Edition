// tools/film/lib/contact_sheet.mjs — one JPEG grid of evenly spaced frames from a take or the final edit.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) has a Claude Code director that cannot watch video, but its Read
// tool views images. A contact sheet (4×4 frames by default, 1920 px wide) lets it review a take or the cut for
// framing, pop-in, occlusion and continuity in one look, then order retakes. ffmpeg builds it:
//   ffmpeg -hide_banner -y -i <video> -vf "select='not(mod(n\,N))',scale=W/cols:-1,tile=<cols>x<rows>"
//          -frames:v 1 -q:v 3 <out.jpg>
// where N = max(1, ⌊frames / (cols·rows)⌋) so the tiles span the whole clip. The frame count comes from ffprobe
// when it is installed, else from the take report / timeline (the drain counts frames exactly).
//
// Pure argv building; the CLI runs it through lib/ffmpeg.mjs runFfmpeg.

import path from "node:path";

import { usageError } from "./args.mjs";

/** Defaults: a 4×4 grid, 1920 px wide. */
export const CONTACT_SHEET_DEFAULTS = Object.freeze({ cols: 4, rows: 4, width: 1920 });

/**
 * Select every N-th frame so cols·rows tiles cover `frames` frames.
 * @param {number} frames
 * @param {number} cols
 * @param {number} rows
 * @returns {number} N ≥ 1
 */
export function everyNth(frames, cols, rows) {
  const tiles = Math.max(1, Math.floor(cols) * Math.floor(rows));
  const f = Math.floor(Number(frames));
  if (!(f > 0)) return 1;
  return Math.max(1, Math.floor(f / tiles));
}

/**
 * The `-vf` filter string.
 * @param {{every: number, cols: number, rows: number, width: number}} o
 * @returns {string}
 */
export function contactSheetFilter({ every, cols, rows, width }) {
  const tileW = Math.max(16, Math.floor(width / cols));
  return `select='not(mod(n\\,${every}))',scale=${tileW}:-1,tile=${cols}x${rows}`;
}

/**
 * Full ffmpeg argv (without the binary) for a contact sheet.
 * @param {{input: string, out?: string, frames: number, cols?: number, rows?: number, width?: number}} o
 * @returns {{argv: string[], out: string, every: number, filter: string}}
 */
export function contactSheetArgv({ input, out, frames, cols = CONTACT_SHEET_DEFAULTS.cols, rows = CONTACT_SHEET_DEFAULTS.rows, width = CONTACT_SHEET_DEFAULTS.width }) {
  if (typeof input !== "string" || !input) throw usageError("contact-sheet needs a video path");
  for (const [k, v, lo, hi] of [["cols", cols, 1, 16], ["rows", rows, 1, 16], ["width", width, 64, 8192]]) {
    if (!(Number.isInteger(v) && v >= lo && v <= hi)) throw usageError(`--${k} must be an integer in [${lo}, ${hi}] (got ${v})`);
  }
  const every = everyNth(frames, cols, rows);
  const filter = contactSheetFilter({ every, cols, rows, width });
  const o = out || defaultContactSheetPath(input);
  return { argv: ["-hide_banner", "-y", "-i", input, "-vf", filter, "-frames:v", "1", "-q:v", "3", o], out: o, every, filter };
}

/**
 * `<dir>/<stem>.contact.jpg` next to the video.
 * @param {string} input
 * @returns {string}
 */
export function defaultContactSheetPath(input) {
  const ext = path.extname(input);
  return path.join(path.dirname(input), `${path.basename(input, ext)}.contact.jpg`);
}
