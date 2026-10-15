// tools/film/plan/edl.mjs — film-mode assembly: compiled Timeline + recorded takes → ffmpeg filter graph (cuts,
// cross-dissolves, fades, music) and a CMX3600 EDL for NLE import. Pure string building — nothing is executed here.
//
// WHY
// ---
// Film mode (`?filmMode=on`, DEFAULT OFF) shoots by SITE (teleports are ≈10 s) but the film plays in EDIT order;
// every take carries handles around its edit range (compile.mjs). `film.mjs assemble` turns the takes back into
// one picture locked to the song: each take is trimmed to its edit range (plus half a transition into its handles
// for a dissolve), joined with `concat` at cuts and `xfade` at dissolves/fades so the program length stays EXACTLY
// the timeline length (music sync), black fills gaps, and the song is mapped with `-ss <offset>`. The EDL hands the
// same cut to Resolve/Premiere when the director wants to finish there.
//
// WHAT
// ----
//   buildAssembly(timeline, takes, {fadeInSec?, fadeOutSec?, audioFile?, audioOffsetSec?, missing='error'})
//     → {segments, audio:{file, offsetSec}|null, totalSec, totalFrames, warnings,
//        ffmpeg:{inputs:[argv], filterComplex, map:[argv], videoLabel:'vout', audioLabel:'aout'|null}}
//   assemblyArgv(assembly, {out, crf=16, preset='medium', audioBitrate='256k', overwrite=true}) → full ffmpeg argv
//   toCmx3600(timeline, takes, {title, recordStart='01:00:00:00', reel='ax'|'shot', audio=true}) → EDL text
//   framesToTimecode(frames, fps) / timecodeToFrames(tc, fps) — non-drop SMPTE at integer fps
//
// takes = { [shotId]: {file, fps?, frames?, durationSec?} } (fps defaults to the timeline fps; length from frames,
// else durationSec; unknown length = assumed long enough).
//
// Frame math (timeline fps F; every boundary is an integer frame): a transition of d frames INTO item k is centred
// on the cut E: pre = ⌊d/2⌋ frames before E come from item k's handle, post = d − pre frames after E from item
// k−1's handle. Segment k feeds take frames [handleIn − pre_k, handleIn + edit + post_{k+1}) to the graph; the xfade
// offset of that dissolve is (E − pre)/F. Σ segment lengths − Σ d = timeline length.
//
// Silent tail (compile.mjs edit.tail; timeline.musicEnd {sec, frame, fadeOutSec}): the last music item carries an
// element-local `fadeOut`, the first tail item an element-local `fadeIn` (from black/white), with a black filler
// between them (the gap). Each is a frame-based `fade` at the END of that element's own chain (after `fps=F`), so
// out → black → in survives the concat; chaining a global fade-out with a global fade-in would blacken the whole
// program (ffmpeg 7.0.2, 2026-10-15). The song is cut at musicEnd (`atrim`), faded there (`afade`), and padded with
// silence to the program length (`apad=whole_dur`), so `-shortest` keeps the whole picture. The program fades stay
// global (start and end). The EDL ends the audio event at musicEnd and writes the two fades as dissolves from/to BL.
// A timeline without musicEnd assembles exactly as before.

import { FilmPlanError } from "../../../scene3d/film/core/errors.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Seconds → shortest decimal string with ≤ 6 decimals ("3.75", "4", "0.033333"). */
function fmt(x) {
  const s = (Math.round(x * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** Seconds → ≤ 6-decimal string rounded DOWN (an xfade offset must never land a frame late). */
function fmtFloor(x) {
  const s = (Math.floor(x * 1e6 + 1e-6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** Basename of a path (both separators). */
function baseName(file) {
  return String(file).split(/[\\/]/).pop();
}

/**
 * Frames → non-drop SMPTE timecode "HH:MM:SS:FF" at an integer frame rate.
 * @param {number} frames ≥ 0 integer
 * @param {number} fps integer 1..120
 * @returns {string}
 */
export function framesToTimecode(frames, fps) {
  if (!Number.isInteger(fps) || fps < 1) throw new FilmPlanError(`timecode needs an integer fps (got ${fps})`, "BAD_ARGUMENT");
  if (!Number.isInteger(frames) || frames < 0) throw new FilmPlanError(`timecode needs a frame count ≥ 0 (got ${frames})`, "BAD_ARGUMENT");
  const ff = frames % fps;
  const totalS = Math.floor(frames / fps);
  const ss = totalS % 60, mm = Math.floor(totalS / 60) % 60, hh = Math.floor(totalS / 3600);
  if (hh > 99) throw new FilmPlanError(`timecode overflow (${frames} frames at ${fps} fps)`, "BAD_ARGUMENT");
  const p2 = (v) => String(v).padStart(2, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${String(ff).padStart(fps > 100 ? 3 : 2, "0")}`;
}

/**
 * "HH:MM:SS:FF" (or a frame count) → frames at an integer frame rate (non-drop).
 * @param {string|number} tc
 * @param {number} fps
 * @returns {number}
 */
export function timecodeToFrames(tc, fps) {
  if (Number.isInteger(tc) && tc >= 0) return tc;
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2,3})$/.exec(String(tc).trim());
  if (!m) throw new FilmPlanError(`not a timecode: ${JSON.stringify(tc)} (expected HH:MM:SS:FF)`, "BAD_ARGUMENT");
  const [h, mi, s, f] = m.slice(1).map(Number);
  if (mi > 59 || s > 59 || f >= fps) throw new FilmPlanError(`timecode out of range: ${tc} at ${fps} fps`, "BAD_ARGUMENT");
  return ((h * 60 + mi) * 60 + s) * fps + f;
}

/** Throws unless `timeline` looks like a compiled Timeline v1. */
function checkTimeline(timeline) {
  if (!isObj(timeline) || !Array.isArray(timeline.items) || !timeline.items.length) {
    throw new FilmPlanError("not a compiled timeline (run `film.mjs plan compile` first)", "TIMELINE_INVALID");
  }
  const { fps, width, height } = timeline;
  if (!Number.isInteger(fps) || fps < 1 || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new FilmPlanError("timeline needs integer fps, width and height", "TIMELINE_INVALID");
  }
}

/**
 * Shared frame layout of the program: elements (takes + black fillers) with record ranges, source ranges and
 * transitions. `missing`: 'error' (throw), 'black' (black filler, warning) or 'virtual' (EDL: clip named
 * `<shotId>.mp4`, unknown length).
 */
function layout(timeline, takes, opts) {
  checkTimeline(timeline);
  const missingMode = opts.missing || "error";
  const fps = timeline.fps;
  const warnings = [];
  const F = (it, fk, sk) => (Number.isInteger(it[fk]) ? it[fk] : Math.round((it[sk] || 0) * fps));
  const items = timeline.items.slice().sort((a, b) => F(a, "editInFrame", "editIn") - F(b, "editInFrame", "editIn"));
  const n = items.length;
  const tk = isObj(takes) ? takes : {};
  const missing = items.filter((it) => !isObj(tk[it.shotId]) || typeof tk[it.shotId].file !== "string" || !tk[it.shotId].file).map((it) => it.shotId);
  if (missing.length && missingMode === "error") {
    throw new FilmPlanError(`no take recorded for shot(s) ${missing.join(", ")} — shoot them or assemble with missing:'black'`,
      { code: "TAKES_MISSING", details: { missing } });
  }
  const isMissing = (it) => missing.includes(it.shotId);
  const rec = items.map((it) => {
    const inF = F(it, "editInFrame", "editIn");
    const outF = F(it, "editOutFrame", "editOut");
    if (outF <= inF) throw new FilmPlanError(`timeline item ${it.shotId} has no frames`, "TIMELINE_INVALID");
    return { inF, outF, hiF: Math.round((it.handleIn || 0) * fps), hoF: Math.round((it.handleOut || 0) * fps) };
  });
  // Transition into item i (dissolve family only; first item handled as the program fade-in by compile, the first
  // silent-tail item by its element-local fadeIn).
  const d = items.map((it, i) => {
    const t = it.transitionIn;
    if (i === 0 || !isObj(t) || t.type === "cut" || !(t.durationSec > 0)) return 0;
    if (isObj(it.fadeIn)) return 0;
    if (rec[i].inF !== rec[i - 1].outF) return 0;
    if (missingMode === "black" && (isMissing(it) || isMissing(items[i - 1]))) return 0;
    return Math.round(t.durationSec * fps);
  });
  const pre = d.map((x) => Math.floor(x / 2));
  const post = d.map((x, i) => x - pre[i]);
  for (let i = 1; i < n; i++) {
    if (!d[i]) continue;
    if (rec[i].hiF < pre[i] && !(missingMode === "virtual" && isMissing(items[i]))) {
      throw new FilmPlanError(`${items[i].shotId}: handleIn ${rec[i].hiF} frame(s) < ${pre[i]} needed for its ${items[i].transitionIn.type}`, "TIMELINE_INVALID");
    }
    if (rec[i - 1].hoF < post[i] && !(missingMode === "virtual" && isMissing(items[i - 1]))) {
      throw new FilmPlanError(`${items[i - 1].shotId}: handleOut ${rec[i - 1].hoF} frame(s) < ${post[i]} needed for the ${items[i].transitionIn.type} into ${items[i].shotId}`, "TIMELINE_INVALID");
    }
  }
  const elements = [];
  let cursorF = 0;
  items.forEach((it, i) => {
    const r = rec[i];
    if (r.inF < cursorF) throw new FilmPlanError(`timeline items overlap at ${it.shotId}`, "TIMELINE_INVALID");
    if (r.inF > cursorF) elements.push({ kind: "black", item: null, shotId: null, recInF: cursorF, recOutF: r.inF, dIn: 0, preIn: 0, postOut: 0, preOut: 0 });
    const editF = r.outF - r.inF;
    const preOut = i + 1 < n ? pre[i + 1] : 0;
    const postOut = i + 1 < n ? post[i + 1] : 0;
    if (isMissing(it) && missingMode === "black") {
      warnings.push({ path: `takes.${it.shotId}`, message: `no take for ${it.shotId}: ${editF} black frame(s) in its place` });
      elements.push({ kind: "black", item: it, shotId: it.shotId, recInF: r.inF, recOutF: r.outF, dIn: 0, preIn: 0, postOut: 0, preOut: 0 });
    } else {
      const take = isMissing(it) ? { file: `${it.shotId}.mp4` } : tk[it.shotId];
      const tfps = isNum(take.fps) && take.fps > 0 ? take.fps : fps;
      const avail = Number.isInteger(take.frames) ? take.frames : isNum(take.durationSec) ? Math.round(take.durationSec * tfps) : Infinity;
      const srcInF = r.hiF - pre[i];
      const srcOutF = r.hiF + editF + postOut;
      const a = Math.round((srcInF / fps) * tfps);
      const b = Math.round((srcOutF / fps) * tfps);
      if (a >= avail) {
        throw new FilmPlanError(`take ${take.file} for ${it.shotId} has ${avail} frame(s); the edit needs frames ${a}..${b}`, { code: "TAKE_TOO_SHORT", details: { shotId: it.shotId, avail, need: b } });
      }
      const padFrames = b > avail ? b - avail : 0;
      if (padFrames) {
        warnings.push({ path: `takes.${it.shotId}`, message: `take ${it.shotId} is ${padFrames} frame(s) short; its last frame is held` });
      }
      // element-local fades (silent tail only): frames of the edit, clamped to it
      const fadeF = (f) => (isObj(f) && isNum(f.durationSec) && f.durationSec > 0 ? Math.min(editF, Math.max(1, Math.round(f.durationSec * fps))) : 0);
      const fadeInF = fadeF(it.fadeIn);
      const fadeOutF = fadeF(it.fadeOut);
      elements.push({
        kind: "take", item: it, shotId: it.shotId, file: take.file, virtual: isMissing(it), tfps, avail,
        recInF: r.inF, recOutF: r.outF, editF, hiF: r.hiF, dIn: d[i], preIn: pre[i], postIn: post[i], preOut, postOut,
        srcInF, srcOutF, takeStartFrame: a, takeEndFrame: b, padFrames,
        transition: d[i]
          ? { type: it.transitionIn.type, durationSec: d[i] / fps, xfade: it.transitionIn.xfade || defaultXfade(it.transitionIn.type) }
          : { type: "cut", durationSec: 0 },
        ...(fadeInF ? { fadeInF, fadeInColor: it.fadeIn.color === "white" ? "white" : "black" } : {}),
        ...(fadeOutF ? { fadeOutF, fadeOutColor: it.fadeOut.color === "white" ? "white" : "black" } : {}),
      });
    }
    cursorF = r.outF;
  });
  // The music part's end (a silent tail follows): the frame the song is cut at, and its fade-out in frames.
  const me = timeline.musicEnd;
  const musicF = isObj(me) && Number.isInteger(me.frame) && me.frame > 0 && me.frame < cursorF ? me.frame : null;
  const musicFadeF = musicF !== null && isNum(me.fadeOutSec) && me.fadeOutSec > 0 ? Math.min(musicF, Math.round(me.fadeOutSec * fps)) : 0;
  return { fps, W: timeline.width, H: timeline.height, elements, totalF: cursorF, musicF, musicFadeF, warnings };
}

function defaultXfade(type) {
  return type === "fade" ? "fadeblack" : type === "fadewhite" ? "fadewhite" : "fade";
}

/** Program fades in frames: options override the timeline (0 disables). */
function programFades(timeline, opts, fps, totalF) {
  const pick = (optSec, tl) => {
    if (isNum(optSec)) return { f: Math.max(0, Math.round(optSec * fps)), color: (tl && tl.color) || "black" };
    if (isObj(tl) && isNum(tl.durationSec)) return { f: Math.max(0, Math.round(tl.durationSec * fps)), color: tl.color || "black" };
    return { f: 0, color: "black" };
  };
  const fin = pick(opts.fadeInSec, timeline.fadeIn);
  const fout = pick(opts.fadeOutSec, timeline.fadeOut);
  fin.f = Math.min(fin.f, totalF);
  fout.f = Math.min(fout.f, totalF);
  return { fin, fout };
}

/**
 * @typedef {object} AssemblySegment
 * @property {'take'|'black'} kind
 * @property {string|null} shotId
 * @property {string|null} file
 * @property {number} trimIn take seconds where the EDIT range starts (= handleIn)
 * @property {number} trimOut take seconds where the EDIT range ends (= handleIn + edit)
 * @property {number} srcIn take seconds actually fed to the graph (trimIn − half the incoming transition)
 * @property {number} srcOut take seconds actually fed to the graph (trimOut + half the outgoing transition)
 * @property {number} editIn @property {number} editOut program seconds of the edit range
 * @property {{type:string, durationSec:number, xfade?:string}} transition INTO this segment
 * @property {number|null} inputIndex ffmpeg input index (null for black)
 */

/**
 * Build the assembly of a compiled timeline from recorded takes: trimmed segments in edit order, the ffmpeg
 * `-filter_complex` graph (`trim` per take at the take's own frame rate, `fps`/`scale`/`format` normalisation,
 * black `color` fillers for gaps, `concat` across cuts re-timed to 1/fps with `settb` so every `xfade` input shares
 * one time base, `xfade` across dissolves/fades with offsets that keep the
 * program exactly `timeline.frames` long, optional program fade-in/out), the audio mapping (`-ss offsetSec -i song`,
 * `atrim` to the program length, `afade` out with the picture) and the `-map` arguments. With a silent tail
 * (`timeline.musicEnd`): element-local `fade`s on the last music element and the first tail element, a black
 * filler for the gap, and `atrim=duration=<musicEnd>,asetpts,afade (music fade-out),apad=whole_dur=<program>`.
 * Throws FilmPlanError: TIMELINE_INVALID, TAKES_MISSING (unless `missing:'black'`), TAKE_TOO_SHORT. A take shorter
 * than its last needed frame is padded by holding its last frame (warning).
 * @param {object} timeline compiled Timeline (compile.mjs)
 * @param {Record<string, {file:string, fps?:number, frames?:number, durationSec?:number}>} takes by shotId
 * @param {{fadeInSec?:number, fadeOutSec?:number, audioFile?:string|null, audioOffsetSec?:number,
 *   missing?:'error'|'black'}} [opts]
 * @returns {{segments:AssemblySegment[], audio:{file:string, offsetSec:number}|null, totalSec:number,
 *   totalFrames:number, musicEnd:{sec:number, frame:number, fadeOutSec:number, tailSec:number}|null,
 *   warnings:{path:string, message:string}[],
 *   ffmpeg:{inputs:string[], filterComplex:string, map:string[], videoLabel:string, audioLabel:string|null,
 *   inputFiles:{index:number, file:string, kind:'video'|'audio'}[]}}}
 */
export function buildAssembly(timeline, takes, opts = {}) {
  const o = opts || {};
  const L = layout(timeline, takes, { missing: o.missing === "black" ? "black" : "error" });
  const { fps, W, H, elements, totalF } = L;
  const inputs = [];
  const inputFiles = [];
  const chains = [];
  const segments = [];
  // Runs of elements joined by cuts (concat); runs are joined by dissolves (xfade). Computed first: a black filler
  // whose run meets an xfade needs an explicit `fps=F` — a `color` source after `trim` leaves its concat run with
  // an unknown frame rate (1/0) that xfade refuses ("First input link main frame rate (30/1) do not match the
  // corresponding second input link xfade frame rate (1/0)"; ffmpeg 7.0.2, 2026-10-15). Without an xfade the filler
  // chain is unchanged.
  const runs = [];
  elements.forEach((e, j) => {
    if (j === 0 || e.dIn > 0) runs.push([]);
    runs[runs.length - 1].push(j);
  });
  const fillerFps = runs.length > 1 ? `,fps=${fps}` : "";
  elements.forEach((e, j) => {
    const label = `e${j}`;
    if (e.kind === "black") {
      const frames = e.recOutF - e.recInF;
      chains.push(`color=c=black:s=${W}x${H}:r=${fps},trim=end_frame=${frames},setpts=PTS-STARTPTS${fillerFps},setsar=1,format=yuv420p[${label}]`);
      segments.push({
        kind: "black", shotId: e.shotId, file: null, trimIn: 0, trimOut: frames / fps, srcIn: 0, srcOut: frames / fps,
        editIn: e.recInF / fps, editOut: e.recOutF / fps, transition: { type: "cut", durationSec: 0 }, inputIndex: null,
      });
      return;
    }
    const idx = inputFiles.length;
    inputFiles.push({ index: idx, file: e.file, kind: "video" });
    inputs.push("-i", e.file);
    const pad = e.padFrames ? `,tpad=stop_mode=clone:stop=${e.padFrames}` : "";
    // Element-local fades (silent tail): frame-based, on this element's own frames at the timeline rate.
    const lenF = e.srcOutF - e.srcInF;
    const local = (e.fadeInF ? `,fade=t=in:start_frame=0:nb_frames=${e.fadeInF}:color=${e.fadeInColor}` : "") +
      (e.fadeOutF ? `,fade=t=out:start_frame=${lenF - e.fadeOutF}:nb_frames=${e.fadeOutF}:color=${e.fadeOutColor}` : "");
    chains.push(`[${idx}:v]trim=start_frame=${e.takeStartFrame}:end_frame=${e.takeEndFrame},setpts=PTS-STARTPTS${pad},` +
      `fps=${fps},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p${local}[${label}]`);
    segments.push({
      kind: "take", shotId: e.shotId, file: e.file,
      trimIn: e.hiF / fps, trimOut: (e.hiF + e.editF) / fps,
      srcIn: e.srcInF / fps, srcOut: e.srcOutF / fps,
      editIn: e.recInF / fps, editOut: e.recOutF / fps,
      transition: e.transition, inputIndex: idx,
      takeStartFrame: e.takeStartFrame, takeEndFrame: e.takeEndFrame, padFrames: e.padFrames,
      ...(e.fadeInF ? { fadeIn: { frames: e.fadeInF, color: e.fadeInColor } } : {}),
      ...(e.fadeOutF ? { fadeOut: { frames: e.fadeOutF, color: e.fadeOutColor } } : {}),
    });
  });
  // Runs of elements joined by cuts → concat; runs joined by dissolves → xfade.
  // One time base everywhere: every element leaves its chain at 1/F (`fps=F` re-times a take, `color=…:r=F` a
  // filler), but `concat` always emits 1/1000000 (AV_TIME_BASE) and `xfade` refuses inputs whose time bases
  // differ ("First input link main timebase (1/30) do not match … (1/1000000)"; ffmpeg 7.0.2 smoke, 2026-10-13).
  // So each concat output is re-timed with `settb=1/F` (exact: its pts are multiples of 1/F, already from 0).
  const runLabel = runs.map((r, k) => {
    if (r.length === 1) return `e${r[0]}`;
    chains.push(`${r.map((j) => `[e${j}]`).join("")}concat=n=${r.length}:v=1:a=0,settb=1/${fps}[r${k}]`);
    return `r${k}`;
  });
  let acc = runLabel[0];
  for (let k = 1; k < runs.length; k++) {
    const e = elements[runs[k][0]];
    const offsetF = e.recInF - e.preIn;
    chains.push(`[${acc}][${runLabel[k]}]xfade=transition=${e.transition.xfade}:duration=${fmt(e.dIn / fps)}:offset=${fmtFloor(offsetF / fps)}[x${k}]`);
    acc = `x${k}`;
  }
  const { fin, fout } = programFades(timeline, o, fps, totalF);
  const post = [];
  if (fin.f > 0) post.push(`fade=t=in:start_frame=0:nb_frames=${fin.f}:color=${fin.color}`);
  if (fout.f > 0) post.push(`fade=t=out:start_frame=${totalF - fout.f}:nb_frames=${fout.f}:color=${fout.color}`);
  post.push("format=yuv420p");
  chains.push(`[${acc}]${post.join(",")}[vout]`);
  // Audio: the song from its offset, trimmed to the program, faded out with the picture — or, with a silent tail,
  // trimmed to the music part, faded out at its end and padded with silence to the program length.
  const song = isObj(timeline.song) ? timeline.song : null;
  const audioFile = typeof o.audioFile === "string" && o.audioFile ? o.audioFile : song && typeof song.file === "string" && song.file ? song.file : null;
  let audio = null;
  const map = ["-map", "[vout]"];
  const { musicF, musicFadeF } = L;
  if (audioFile) {
    const offsetSec = isNum(o.audioOffsetSec) ? o.audioOffsetSec : song && isNum(song.offsetSec) ? song.offsetSec : 0;
    audio = { file: audioFile, offsetSec };
    const ai = inputFiles.length;
    inputFiles.push({ index: ai, file: audioFile, kind: "audio" });
    inputs.push("-ss", fmt(offsetSec), "-i", audioFile);
    if (musicF !== null) {
      const af = musicFadeF > 0 ? `,afade=t=out:st=${fmt((musicF - musicFadeF) / fps)}:d=${fmt(musicFadeF / fps)}` : "";
      chains.push(`[${ai}:a]atrim=duration=${fmt(musicF / fps)},asetpts=PTS-STARTPTS${af},apad=whole_dur=${fmt(totalF / fps)}[aout]`);
    } else {
      const af = fout.f > 0 ? `,afade=t=out:st=${fmt((totalF - fout.f) / fps)}:d=${fmt(fout.f / fps)}` : "";
      chains.push(`[${ai}:a]atrim=duration=${fmt(totalF / fps)},asetpts=PTS-STARTPTS${af}[aout]`);
    }
    map.push("-map", "[aout]");
  }
  return {
    segments,
    audio,
    totalSec: totalF / fps,
    totalFrames: totalF,
    musicEnd: musicF !== null ? { sec: musicF / fps, frame: musicF, fadeOutSec: musicFadeF / fps, tailSec: (totalF - musicF) / fps } : null,
    warnings: L.warnings,
    ffmpeg: { inputs, filterComplex: chains.join(";"), map, videoLabel: "vout", audioLabel: audio ? "aout" : null, inputFiles, fps },
  };
}

/**
 * Full ffmpeg argv (without the binary) for an assembly: inputs, the filter graph, maps, H.264 yuv420p video,
 * AAC audio when mapped, faststart.
 * @param {ReturnType<typeof buildAssembly>} assembly
 * @param {{out:string, crf?:number, preset?:string, audioBitrate?:string, overwrite?:boolean}} opts
 * @returns {string[]}
 */
export function assemblyArgv(assembly, opts) {
  const { out, crf = 16, preset = "medium", audioBitrate = "256k", overwrite = true } = opts || {};
  if (typeof out !== "string" || !out) throw new FilmPlanError("assemblyArgv: out path required", "BAD_ARGUMENT");
  const f = assembly.ffmpeg;
  const argv = ["-hide_banner", overwrite ? "-y" : "-n", ...f.inputs, "-filter_complex", f.filterComplex, ...f.map,
    "-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p", "-r", String(f.fps)];
  if (f.audioLabel) argv.push("-c:a", "aac", "-b:a", audioBitrate, "-shortest");
  argv.push("-movflags", "+faststart", out);
  return argv;
}

/**
 * CMX3600 EDL of a compiled timeline (one video track; optional song on channel A) for NLE import. Non-drop
 * timecode at the timeline fps; record timecode starts at `recordStart` (default 01:00:00:00); source timecode is
 * the take's own frame count from 00:00:00:00 (handles included). Cuts are `C` events; a dissolve/fade is the
 * standard two-line event (outgoing clip zero-length `C`, incoming clip `D nnn`) starting ⌊d/2⌋ frames before the
 * cut; program fade-in/out are dissolves from/to `BL`; gaps are `BL` events. Each event carries
 * `* FROM CLIP NAME:` (and `* TO CLIP NAME:` for transitions). Missing takes are named `<shotId>.mp4`. With a silent
 * tail (`timeline.musicEnd`) the music part's element-local fade-out is a dissolve to `BL`, the gap a `BL` event,
 * the tail's fade-in a dissolve from `BL`, and the song's audio event ends at musicEnd.
 * @param {object} timeline compiled Timeline
 * @param {Record<string, {file:string, fps?:number, frames?:number, durationSec?:number}>} [takes]
 * @param {{title?:string, recordStart?:string|number, reel?:'ax'|'shot', audio?:boolean, fadeInSec?:number,
 *   fadeOutSec?:number}} [opts]
 * @returns {string} EDL text ('\n' line endings, trailing newline)
 */
export function toCmx3600(timeline, takes = {}, opts = {}) {
  const o = opts || {};
  const L = layout(timeline, takes, { missing: "virtual" });
  const { fps, elements, totalF, musicF } = L;
  const tc = (f) => framesToTimecode(f, fps);
  const rec0 = timecodeToFrames(o.recordStart ?? "01:00:00:00", fps);
  // eslint-disable-next-line no-control-regex
  const title = String(o.title ?? timeline.title ?? "FILM").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 70) || "FILM";
  const reelOf = (e) => {
    if (e.kind === "black") return "BL";
    if (o.reel === "shot") return (String(e.shotId).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "AX");
    return "AX";
  };
  const clipName = (e) => (e.kind === "black" ? "BLACK" : baseName(e.file));
  const { fin, fout } = programFades(timeline, o, fps, totalF);
  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  let ev = 0;
  const line = (n, reel, chan, trans, dur, sIn, sOut, rIn, rOut) => {
    if (n > 999) throw new FilmPlanError("CMX3600 supports at most 999 events", "EDL_TOO_LONG");
    const d = dur === null ? "   " : String(dur).padStart(3, "0");
    return `${String(n).padStart(3, "0")}  ${reel.padEnd(8)} ${chan.padEnd(5)} ${trans.padEnd(4)} ${d} ${tc(sIn)} ${tc(sOut)} ${tc(rIn + rec0)} ${tc(rOut + rec0)}`;
  };
  // Record span shown "alone" by each element: from its transition start to the next transition start.
  const spans = elements.map((e, j) => {
    let rs = e.recInF - (e.preIn || 0);
    let re = e.recOutF - (j + 1 < elements.length ? elements[j + 1].preIn || 0 : 0);
    if (j === 0) rs = 0;
    if (j === elements.length - 1 && fout.f > 0) re = Math.min(re, totalF - fout.f);
    if (e.fadeOutF) re = Math.min(re, e.recOutF - e.fadeOutF); // element-local fade-out: its own BL dissolve
    const ss = e.kind === "take" ? e.srcInF : 0;
    return { rs, re, ss, se: ss + (re - rs) };
  });
  const srcAt = (j, recF) => spans[j].ss + (recF - spans[j].rs);
  elements.forEach((e, j) => {
    const s = spans[j];
    ev++;
    const fadeFromBlack = j === 0 && fin.f > 0 && e.kind === "take";
    if (fadeFromBlack || (e.kind === "take" && e.fadeInF)) {
      lines.push(line(ev, "BL", "V", "C", null, 0, 0, s.rs, s.rs));
      lines.push(line(ev, reelOf(e), "V", "D", fadeFromBlack ? fin.f : e.fadeInF, s.ss, s.se, s.rs, s.re));
      lines.push(`* FROM CLIP NAME: BLACK`, `* TO CLIP NAME: ${clipName(e)}`, "");
    } else if (e.dIn > 0 && j > 0) {
      const prev = elements[j - 1];
      const at = srcAt(j - 1, s.rs);
      lines.push(line(ev, reelOf(prev), "V", "C", null, at, at, s.rs, s.rs));
      lines.push(line(ev, reelOf(e), "V", "D", e.dIn, s.ss, s.se, s.rs, s.re));
      lines.push(`* FROM CLIP NAME: ${clipName(prev)}`, `* TO CLIP NAME: ${clipName(e)}`, "");
    } else {
      lines.push(line(ev, reelOf(e), "V", "C", null, s.ss, s.se, s.rs, s.re));
      lines.push(`* FROM CLIP NAME: ${clipName(e)}`, "");
    }
    if (e.kind === "take" && e.fadeOutF) {
      // the music part's element-local fade-out (a silent tail follows): a dissolve to BL ending on the element's end
      const start = e.recOutF - e.fadeOutF;
      const at = srcAt(j, start);
      ev++;
      lines.push(line(ev, reelOf(e), "V", "C", null, at, at, start, start));
      lines.push(line(ev, "BL", "V", "D", e.fadeOutF, 0, e.fadeOutF, start, e.recOutF));
      lines.push(`* FROM CLIP NAME: ${clipName(e)}`, "* TO CLIP NAME: BLACK", "");
    }
  });
  if (fout.f > 0) {
    const j = elements.length - 1;
    const start = totalF - fout.f;
    const at = srcAt(j, start);
    ev++;
    lines.push(line(ev, reelOf(elements[j]), "V", "C", null, at, at, start, start));
    lines.push(line(ev, "BL", "V", "D", fout.f, 0, fout.f, start, totalF));
    lines.push(`* FROM CLIP NAME: ${clipName(elements[j])}`, "* TO CLIP NAME: BLACK", "");
  }
  const song = isObj(timeline.song) ? timeline.song : null;
  if (o.audio !== false && song && typeof song.file === "string" && song.file) {
    const off = Math.round((isNum(song.offsetSec) ? song.offsetSec : 0) * fps);
    const audioF = musicF !== null ? musicF : totalF; // a silent tail has no song under it
    ev++;
    lines.push(line(ev, "AX", "A", "C", null, off, off + audioF, 0, audioF));
    lines.push(`* FROM CLIP NAME: ${baseName(song.file)}`, "");
  }
  return lines.join("\n");
}
