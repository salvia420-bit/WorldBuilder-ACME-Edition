// tools/film/plan/compile.mjs — film-mode plan compiler: Plan JSON v1 (+ SongAnalysis) → Timeline (edit times on the
// beat grid, take lengths with handles, pre-roll) + shooting schedule (by site, fewest teleports).
//
// WHY
// ---
// Film mode (`?filmMode=on`, DEFAULT OFF): the director writes plan.json in EDIT order, but the hidden player is the
// streaming dolly and a teleport costs ≈10 s, so takes must be SHOT by site (SPEC §0: shooting schedule ≠ edit
// order; never record across a teleport) and assembled back in edit order. Music videos cut on beats and downbeats,
// so every cut is placed on the song's beat grid here, once, deterministically — the CLI (`film.mjs plan compile`,
// `shoot`, `assemble`) and the EDL builder (edl.mjs) only read the compiled Timeline.
//
// WHAT
// ----
//   compilePlan(plan, {song?, registry?, sectionSnapBars=0.5}) → Timeline
//   estimateShootTime(timeline, {teleportSec=12, settleSec=5, stepFps=8}) → {totalSec, …, text}
//   songGrid(song, {offsetSec=0}) → beat/bar/section grid in EDIT time (exported for the CLI and tests)
//   greedySiteOrder(sites) → site order (nearest-neighbour from the first, stable)
//
// Timeline v1 = { version:1, title, kind, fps, width, height, duration (s), frames, song:{file, analysis, offsetSec,
//   bpm, durationSec}|null, fadeIn:{durationSec, color}|null, fadeOut:{durationSec, color}|null,
//   musicEnd?:{sec, frame, fadeOutSec} (ONLY with edit.tail: where the music part ends — the song is cut there),
//   items:[{index, shotId, siteId, editIn, editOut, editDuration, editInFrame, editOutFrame, takeDuration, takeFrames,
//           handleIn, handleOut, transitionIn:{type, durationSec, xfade?, fromColor?},
//           fadeIn?:{durationSec, color}, fadeOut?:{durationSec, color} (element-local, ONLY around a silent tail),
//           preRollSec, technique, family,
//           captureMode, snap:'none'|'beat'|'bar'|'section', explicitStart, requested:{duration, start},
//           trim:{takeSec, inSec, requestedInSec}|null, section:{i, label, role}|null, lyric, notes, take}],
//   schedule:[{siteId, name, teleport, prime? (site.prime: ['@…'], only when set), anchor, cell, indoor, travelM,
//              ready:{lbKeys, interiorLb, settleSec, timeoutSec}, prewarm:{points, radius}, shots:[ids], takeSec}],
//   warnings:[{path, message}], source:{planHash} }
// item.take = what `__film.prepare(take)` needs: {shotId, siteId, technique, family, spec (SPEC §2.11 ShotSpec with
//   duration = takeDuration, + the shot's `bounds` override when set), subject (the normalized plan subject: a
//   `moving: true` entity, or a player subject whose actor walks — normalized `moving: true` — is followed live by
//   the page), path, route, standingOrder, goal,
//   pilot (incl. `fade` 'never'|'auto' when the plan sets it), capture:{mode, fps, width, height} (mode as normalized
//   WITH the registry: a technique's 'realtime' capture hint makes an entity/player subject realtime),
//   look, actor, cell, indoor, anchor, editOffsetSec (= handleIn: where the edit starts inside the take), preRollSec,
//   showAvatar, overlay (shot.overlay {props:{style, opacity?, tint?}} or null: the page's lens overlay)}.
//
// Rules (all times are EDIT seconds; frame-quantised at format.fps; song indices are 0-based SONG indices):
//   • Items are contiguous in plan order; an explicit `start` jumps: a gap is black (warning); an overlap trims the
//     previous shot (warning); a start at/before the previous shot's start is an error.
//   • {beats:n} → n beats of the song's beat spacing (cut on the nearest beat); {bars:n} → n bars of song.bars (a
//     shot that starts on a downbeat, or within half a beat of one — e.g. song.offsetSec 15.0 copied from
//     `song analyze` for a downbeat at 14.98 s — counts from THAT downbeat and cuts on a downbeat; a shot that
//     starts more than half a beat before the song's first downbeat — the pickup, e.g. the first shot at edit 0
//     when bars[0] is at 0.51 s — or that opens the edit further than that inside a bar (song.offsetSec mid-bar)
//     counts its bars from the NEXT downbeat (bar 0 for a pickup shorter than a bar), so the pickup joins it and
//     the cut lands on a downbeat; any other mid-bar start keeps the length and cuts on the nearest beat);
//     {sec:s} → the cut snaps to the nearest beat, or to a section start (a downbeat) when one lies within
//     `sectionSnapBars` bars (the next shot "starts the section"). No song: seconds as written;
//     beats/bars/{beat|bar|section} starts are an error.
//   • A dissolve/fade INTO shot k (k > 0) gives handleOut(k−1) = handleIn(k) = transition length (default 0.5 s) and
//     is centred on the cut in the assembly; a non-cut transition on the first shot is a fade-in from black/white.
//   • takeDuration = editDuration + handleIn + handleOut; preRollSec = max(6/fps, 0.25) + site.settleSec (rendered,
//     never recorded, not part of the edit).
//   • A shot with trim:{takeSec, inSec} is flown as a take of takeSec (its move keeps the speed it has at that length)
//     and the edit is the window from inSec: handleIn = inSec, handleOut = takeSec − inSec − edit, so the EDL cuts the
//     window (and any dissolve material around it) out of the one take. inSec is moved into
//     [transition handle in, takeSec − edit − transition handle out] with a warning; an edit + handles longer than
//     takeSec throws PLAN_INVALID (lengthening the take would slow the move — shorten the edit instead).
//   • edit.tail {from, gapSec, fadeOutSec} (k = index of `from`, k ≥ 1): shots 0…k−1 are the MUSIC PART and compile
//     exactly as they would without the tail (same items, same frames, same handles); musicEnd = the frame where
//     shot k−1 ends. edit.fadeOutSec becomes items[k−1].fadeOut (element-local, same room rule as the program
//     fade-out), then gapSec of black (frame-quantised), then the TAIL: items[k].editIn = musicEnd + gapSec, every
//     tail shot exactly its {sec} (snap 'none', no section), contiguous. A non-cut transition into shot k is an
//     element-local fade-in from black/white (items[k].fadeIn; no handles, so the finale's trim window never
//     moves); transitions between tail shots are ordinary (handles from tail takes). The program fade-out is
//     tail.fadeOutSec on the last shot; the "past the end of the song" warning compares musicEnd.
//   • Schedule: sites grouped; order = greedy nearest anchor (straight line) starting from the first site in edit
//     order, ties by first appearance; each site once; shots inside a site in edit order. A site's `prime` commands
//     ride along on its schedule entry (film shoot sends them before the site teleport).
//
// Pure: no I/O, no clocks; the same plan + song always compiles to the same JSON.

import { FilmPlanError } from "../../../scene3d/film/core/errors.js";
import { hashString } from "../../../scene3d/film/core/rng.js";
import { parseCellId } from "../../../scene3d/film/core/units.js";
import { shotSpec, shotUsesSong, tailIndexOf, validatePlan } from "./schema.mjs";

/** Timeline schema version. */
export const TIMELINE_VERSION = 1;

/** Compiler constants. */
export const COMPILE_DEFAULTS = Object.freeze({
  /** A {sec} cut within this many bars of a section start lands ON the section start. */
  sectionSnapBars: 0.5,
  /** Pre-roll floor in frames (SPEC §3 take player: ≥ 6 frames rendered, not recorded, after a cut). */
  preRollFrames: 6,
  /** Pre-roll floor in seconds. */
  minPreRollSec: 0.25,
  /** Shortest dissolve/fade kept (shorter → cut). */
  minTransitionFrames: 2,
  /** Beats per bar when bars must be derived from beats (4/4). */
  beatsPerBar: 4,
  /** A {bars} shot that starts within this many beats of a bar line (before or after it) counts from that bar. */
  barLineTolBeats: 0.5,
  /** world.prewarm radius (metres) around each schedule point. */
  prewarmRadius: 96,
  /** Warn when a {sec} duration moves by more than this fraction on the beat grid. */
  snapWarnFraction: 0.3,
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r3 = (x) => Math.round(x * 1e3) / 1e3;

function median(xs) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function diffs(xs) {
  const out = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i] - xs[i - 1]);
  return out;
}

/** Sorted, de-duplicated finite numbers. */
function cleanTimes(arr) {
  const xs = (Array.isArray(arr) ? arr : []).filter(isNum).slice().sort((a, b) => a - b);
  const out = [];
  for (const x of xs) if (!out.length || x - out[out.length - 1] > 1e-6) out.push(x);
  return out;
}

/** Time at fractional index `pos` of a sorted grid, extrapolated with `step` beyond either end. */
function timeAt(arr, step, pos) {
  const n = arr.length;
  if (pos <= 0) return arr[0] + pos * step;
  if (pos >= n - 1) return arr[n - 1] + (pos - (n - 1)) * step;
  const k = Math.floor(pos);
  return arr[k] + (pos - k) * (arr[k + 1] - arr[k]);
}

/** Fractional index of time `t` on a sorted grid (inverse of timeAt). */
function posAt(arr, step, t) {
  const n = arr.length;
  if (t <= arr[0]) return (t - arr[0]) / step;
  if (t >= arr[n - 1]) return n - 1 + (t - arr[n - 1]) / step;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = arr[lo + 1] - arr[lo];
  return lo + (span > 0 ? (t - arr[lo]) / span : 0);
}

/** Nearest grid point (extrapolated grid included) to `t`. */
function nearestOnGrid(arr, step, t) {
  const p = posAt(arr, step, t);
  const a = timeAt(arr, step, Math.floor(p));
  const b = timeAt(arr, step, Math.ceil(p));
  return t - a <= b - t ? a : b;
}

/** First grid point ≥ t (extrapolated grid included). */
function ceilOnGrid(arr, step, t) {
  let k = Math.ceil(posAt(arr, step, t) - 1e-9);
  let x = timeAt(arr, step, k);
  while (x < t - 1e-9) x = timeAt(arr, step, ++k);
  return x;
}

/**
 * @typedef {object} SongGrid
 * @property {number} offsetSec song time at edit t=0
 * @property {number[]} beats beat times in EDIT seconds (index = song beat index)
 * @property {number[]} barStarts bar start times in EDIT seconds (index = song bar index)
 * @property {number} period median beat spacing (s)
 * @property {number} barLen median bar length (s)
 * @property {{i:number, start:number, end:number, label:string|null, role:string|null}[]} sections EDIT seconds
 * @property {number|null} endSec song end in EDIT seconds
 * @property {(pos:number) => number} beatTime fractional beat index → time (extrapolated)
 * @property {(t:number) => number} beatPos time → fractional beat index
 * @property {(pos:number) => number} barTime fractional bar index → time (extrapolated)
 * @property {(t:number) => number} barPos time → fractional bar index
 * @property {(t:number) => number} nearestBeat
 * @property {(t:number) => number} nearestDownbeat
 * @property {(t:number) => number} ceilBeat first beat ≥ t
 * @property {(t:number) => ({i:number, start:number, end:number, label:string|null, role:string|null}|null)} sectionAt
 */

/**
 * Beat / bar / section grid of a SongAnalysis (tools/film/audio/analyze.mjs) in EDIT time
 * (edit t = song t − offsetSec). Beats come from `song.beats` (fewer than 2 → synthesised from tempo.bpm), bars
 * from `song.bars` (else `downbeats`, else every 4th beat), extrapolated beyond either end at the median spacing.
 * Throws FilmPlanError (code SONG_INVALID) when the analysis has no usable beat grid.
 * @param {object} song SongAnalysis
 * @param {{offsetSec?:number, beatsPerBar?:number}} [opts]
 * @returns {SongGrid}
 */
export function songGrid(song, opts = {}) {
  const offset = isNum(opts.offsetSec) ? opts.offsetSec : 0;
  const bpb = isNum(opts.beatsPerBar) && opts.beatsPerBar > 0 ? opts.beatsPerBar : COMPILE_DEFAULTS.beatsPerBar;
  if (!isObj(song)) throw new FilmPlanError("song analysis must be an object (song.json from `film.mjs song analyze`)", "SONG_INVALID");
  let beats = cleanTimes(song.beats);
  const bpm = isObj(song.tempo) && isNum(song.tempo.bpm) && song.tempo.bpm > 0 ? song.tempo.bpm : null;
  const durationSec = isNum(song.durationSec) && song.durationSec > 0 ? song.durationSec : null;
  if (beats.length < 2) {
    if (!bpm) throw new FilmPlanError("song analysis has fewer than 2 beats and no tempo.bpm — re-run `film.mjs song analyze`", "SONG_INVALID");
    const p = 60 / bpm;
    const t0 = beats.length ? beats[0] : cleanTimes(song.downbeats)[0] ?? 0;
    const end = durationSec ?? t0 + 256 * p;
    beats = [];
    for (let k = 0; t0 + k * p <= end + 1e-9; k++) beats.push(t0 + k * p);
    if (beats.length < 2) beats.push(t0 + p);
  }
  const period = median(diffs(beats));
  if (!(period > 0)) throw new FilmPlanError("song analysis beats have no positive spacing", "SONG_INVALID");
  let barStarts;
  let lastBarEnd = null;
  const bars = Array.isArray(song.bars) ? song.bars.filter((b) => isObj(b) && isNum(b.start)) : [];
  if (bars.length) {
    barStarts = bars.map((b) => b.start);
    const last = bars[bars.length - 1];
    lastBarEnd = isNum(last.end) && last.end > last.start ? last.end : null;
  } else {
    const db = cleanTimes(song.downbeats);
    barStarts = db.length ? db : beats.filter((_, k) => k % bpb === 0);
  }
  barStarts = cleanTimes(barStarts);
  let barLen = barStarts.length >= 2 ? median(diffs(barStarts)) : period * bpb;
  if (!(barLen > 0)) barLen = period * bpb;
  // Bar grid: starts plus the end of the last bar, so a position inside the last bar interpolates to its end.
  const barArr = barStarts.concat([lastBarEnd ?? barStarts[barStarts.length - 1] + barLen]);
  const bE = beats.map((t) => t - offset);
  const barE = barArr.map((t) => t - offset);
  const sections = (Array.isArray(song.sections) ? song.sections : [])
    .filter((s) => isObj(s) && isNum(s.start))
    .map((s, k) => ({
      i: Number.isInteger(s.i) ? s.i : k,
      start: s.start - offset,
      end: isNum(s.end) ? s.end - offset : Infinity,
      label: typeof s.label === "string" ? s.label : null,
      role: typeof s.role === "string" ? s.role : null,
    }));
  return {
    offsetSec: offset,
    beats: bE,
    barStarts: barE.slice(0, barStarts.length),
    period,
    barLen,
    sections,
    endSec: durationSec !== null ? durationSec - offset : null,
    beatTime: (pos) => timeAt(bE, period, pos),
    beatPos: (t) => posAt(bE, period, t),
    barTime: (pos) => timeAt(barE, barLen, pos),
    barPos: (t) => posAt(barE, barLen, t),
    nearestBeat: (t) => nearestOnGrid(bE, period, t),
    nearestDownbeat: (t) => nearestOnGrid(barE, barLen, t),
    ceilBeat: (t) => ceilOnGrid(bE, period, t),
    sectionAt: (t) => sections.find((s) => t >= s.start - 1e-9 && t < s.end - 1e-9) || null,
  };
}

/** Resolve an explicit start to EDIT seconds. */
function resolveStart(start, grid, shotLabel, warn, path) {
  if (has(start, "sec")) return start.sec;
  if (!grid) throw new FilmPlanError(`${shotLabel}: start ${JSON.stringify(start)} needs a song analysis`, "SONG_REQUIRED");
  if (has(start, "beat")) {
    if (start.beat >= grid.beats.length) warn(`${path}.start.beat`, `beat ${start.beat} is past the song's last beat (${grid.beats.length - 1}); extrapolated`);
    return grid.beatTime(start.beat);
  }
  if (has(start, "bar")) {
    if (start.bar >= grid.barStarts.length) warn(`${path}.start.bar`, `bar ${start.bar} is past the song's last bar (${grid.barStarts.length - 1}); extrapolated`);
    return grid.barTime(start.bar);
  }
  const k = start.section;
  const sec = grid.sections[k];
  if (!sec) throw new FilmPlanError(`${shotLabel}: start.section ${k} but the song has ${grid.sections.length} section(s) (0-based)`, "PLAN_INVALID");
  return sec.start;
}

/** Resolve the edit-out time of a shot starting at `inT`. */
function resolveEnd(inT, dur, grid, o) {
  const minT = inT + 1 / o.fps;
  if (has(dur, "sec")) {
    const target = inT + dur.sec;
    if (!grid) return { t: target, snap: "none" };
    const tol = o.sectionSnapBars * grid.barLen;
    let best = null;
    for (const s of grid.sections) {
      if (s.start < minT - 1e-9) continue;
      const d = Math.abs(s.start - target);
      if (d <= tol + 1e-9 && (best === null || d < Math.abs(best.start - target) - 1e-9)) best = s;
    }
    if (best) return { t: best.start, snap: "section" };
    let t = grid.nearestBeat(target);
    if (t < minT - 1e-9) t = grid.ceilBeat(minT);
    return { t, snap: "beat" };
  }
  if (has(dur, "beats")) {
    const n = dur.beats;
    let pos = grid.beatPos(inT) + n;
    if (Number.isInteger(n)) pos = Math.round(pos);
    let t = grid.beatTime(pos);
    if (t < minT - 1e-9) t = grid.ceilBeat(minT);
    return { t, snap: "beat" };
  }
  // n bars of the song's own bar lengths, counted so that every contiguous {bars} cut stays on a bar line
  // (tol = COMPILE_DEFAULTS.barLineTolBeats × the beat spacing, half a beat):
  //   • the pickup — a start more than tol BEFORE the song's first downbeat (the first shot at edit 0 whenever
  //     bars[0], the first detected downbeat, is later than tol, e.g. 0.51 s) counts from the NEXT downbeat (bar 0
  //     for a pickup shorter than a bar), so the pickup joins the shot;
  //   • ON a bar line — a start within tol of a downbeat counts from THAT downbeat. This is what keeps an edit-0
  //     start that is only slightly past a downbeat on it: song.offsetSec copied from `song analyze`'s one-decimal
  //     section times (15.0 for a downbeat at 14.98 s) or 8.001 on a grid at 0 gives n bars less those few ms, not
  //     n + 1 bars. A start just before a downbeat counts from it the same way;
  //   • edit 0 mid-bar (song.offsetSec more than tol inside a bar) counts from the NEXT downbeat;
  //   • any other mid-bar start (after a {beats}/{sec} shot, an explicit {sec}/{beat} start) keeps the length and
  //     lands on the nearest beat. A fractional n always lands on the nearest beat.
  const n = dur.bars;
  const bp = grid.barPos(inT);
  const tolSec = COMPILE_DEFAULTS.barLineTolBeats * grid.period;
  const k = Math.round(bp);
  let base;
  if (bp < 0 && inT - grid.barTime(0) < -tolSec - 1e-9) base = Math.ceil(bp - 1e-6); // pickup → next downbeat
  else if (Math.abs(inT - grid.barTime(k)) <= tolSec + 1e-9) base = k; // on (or within tol of) bar line k
  else if (inT <= 1e-9) base = Math.ceil(bp); // edit 0 mid-bar → next downbeat
  else base = bp; // any other mid-bar start keeps its length
  const pos = base + n;
  const posR = Math.round(pos);
  let t = Math.abs(pos - posR) < 1e-6 ? grid.barTime(posR) : grid.nearestBeat(grid.barTime(pos));
  if (t < minT - 1e-9) t = grid.ceilBeat(minT);
  return { t, snap: "bar" };
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));

/**
 * Greedy nearest-neighbour site order: start at sites[0] (the first site in edit order), then repeatedly the
 * unvisited site whose anchor is closest (straight line) to the last one; ties keep input order. Sites without a
 * finite anchor are visited last in input order.
 * @param {{id:string, anchor:number[]}[]} sites in first-use (edit) order
 * @returns {{id:string, travelM:number|null}[]}
 */
export function greedySiteOrder(sites) {
  const ok = (s) => Array.isArray(s.anchor) && s.anchor.length >= 2 && s.anchor.every(isNum);
  if (!sites.length) return [];
  const out = [{ id: sites[0].id, travelM: null }];
  let last = sites[0];
  const rest = sites.slice(1);
  while (rest.length) {
    let bi = -1, bd = Infinity;
    if (ok(last)) {
      rest.forEach((s, i) => {
        if (!ok(s)) return;
        const d = dist3(last.anchor, s.anchor);
        if (d < bd - 1e-9) { bd = d; bi = i; }
      });
    }
    if (bi < 0) { bi = 0; bd = NaN; }
    const [s] = rest.splice(bi, 1);
    out.push({ id: s.id, travelM: Number.isFinite(bd) ? r3(bd) : null });
    last = s;
  }
  return out;
}

/**
 * Compile a plan into a Timeline (edit order) + shooting schedule (site order). Validates first (with the injected
 * registry when given) and throws FilmPlanError (code PLAN_INVALID, details {errors, warnings}) on an invalid plan,
 * SONG_REQUIRED when beats/bars/musical starts are used without `song`, SONG_INVALID for an unusable analysis.
 * Validation warnings are carried into `timeline.warnings` together with the compiler's own (gaps, overlaps,
 * clamped transitions, big snaps, edit longer than the song).
 * @param {object} plan Plan JSON v1 (raw or normalized)
 * @param {{song?:object|null, registry?:import("./schema.mjs").TechniqueRegistry|null, sectionSnapBars?:number}} [opts]
 * @returns {object} Timeline v1 (JSON-safe)
 */
export function compilePlan(plan, opts = {}) {
  const { song = null, registry = null } = opts || {};
  const sectionSnapBars = isNum(opts && opts.sectionSnapBars) ? opts.sectionSnapBars : COMPILE_DEFAULTS.sectionSnapBars;
  const v = validatePlan(plan, { registry });
  if (!v.ok) {
    const head = v.errors.slice(0, 4).map((e) => `${e.path || "(plan)"}: ${e.message}`).join("; ");
    throw new FilmPlanError(`plan is invalid — ${v.errors.length} error(s): ${head}${v.errors.length > 4 ? ` (+${v.errors.length - 4} more)` : ""}`,
      { code: "PLAN_INVALID", details: { errors: v.errors, warnings: v.warnings } });
  }
  const p = v.plan;
  const warnings = v.warnings.map((w) => ({ ...w }));
  const warn = (path, message) => warnings.push({ path, message });
  const fps = p.format.fps;
  const offset = isObj(p.song) ? p.song.offsetSec : 0;
  const shots = p.shots;
  const siteById = new Map(p.sites.map((s) => [s.id, s]));

  const musical = shots.filter(shotUsesSong).map((s) => s.id);
  if (musical.length && !song) {
    throw new FilmPlanError(`shot(s) ${musical.join(", ")} use beats/bars/musical starts but no song analysis was given (compile with --song=song.json)`,
      { code: "SONG_REQUIRED", details: { shots: musical } });
  }
  const grid = song ? songGrid(song, { offsetSec: offset }) : null;
  if (song && !isObj(p.song)) warn("song", "a song analysis was given but plan.song is missing (offsetSec 0 assumed; assembly gets no audio unless the CLI passes --song)");

  // The silent tail (edit.tail): shots k… follow the music part after gapF black frames, in exact seconds.
  const tail = isObj(p.edit) && isObj(p.edit.tail) ? p.edit.tail : null;
  const k = tail ? tailIndexOf(p) : -1; // validated: ≥ 1 whenever a tail is set
  const inTail = (i) => k > 0 && i >= k;
  const gapF = k > 0 ? Math.round(tail.gapSec * fps) : 0;

  // ── pass 1: exact edit times ──
  const pos = [];
  let cursor = 0;
  shots.forEach((s, i) => {
    const path = `shots[${i}]`;
    let inT = cursor;
    // the first tail shot starts gapF frames after the frame the music part ends on
    if (i === k) inT = (Math.round(cursor * fps) + gapF) / fps;
    const explicit = s.start !== null && s.start !== undefined;
    if (explicit) inT = resolveStart(s.start, grid, s.id, warn, path);
    if (!(inT >= -1e-9)) {
      throw new FilmPlanError(`${s.id}: start resolves to ${r3(inT)} s, before the edit begins (song.offsetSec ${offset})`, "PLAN_INVALID");
    }
    inT = Math.max(0, inT);
    // tail shots are never on the beat grid: resolveEnd without a grid = the seconds as written (snap 'none')
    const { t: outT, snap } = resolveEnd(inT, s.duration, inTail(i) ? null : grid, { fps, sectionSnapBars });
    if (has(s.duration, "sec") && grid && !inTail(i)) {
      const got = outT - inT;
      if (Math.abs(got - s.duration.sec) > COMPILE_DEFAULTS.snapWarnFraction * s.duration.sec + 1e-9) {
        warn(`${path}.duration`, `${s.id}: {sec: ${s.duration.sec}} became ${r3(got)} s on the beat grid (${snap} snap)`);
      }
    }
    pos.push({ inT, outT, explicit, snap });
    cursor = outT;
  });

  // ── pass 2: frames, gaps and overlaps ──
  const F = (t) => Math.round(t * fps);
  const fr = pos.map((q) => ({ inF: F(q.inT), outF: F(q.outT) }));
  for (let i = 1; i < shots.length; i++) {
    if (!pos[i].explicit) continue;
    const prev = fr[i - 1];
    if (fr[i].inF > prev.outF) {
      warn(`shots[${i}].start`, `${r3((fr[i].inF - prev.outF) / fps)} s gap (black) between ${shots[i - 1].id} and ${shots[i].id}`);
    } else if (fr[i].inF < prev.outF) {
      if (fr[i].inF <= prev.inF) {
        throw new FilmPlanError(`${shots[i].id} starts at ${r3(fr[i].inF / fps)} s, at or before ${shots[i - 1].id} begins (${r3(prev.inF / fps)} s) — shots must be listed in edit order`, "PLAN_INVALID");
      }
      warn(`shots[${i}].start`, `${shots[i].id} starts ${r3((prev.outF - fr[i].inF) / fps)} s before ${shots[i - 1].id} ends; ${shots[i - 1].id} is trimmed to ${r3((fr[i].inF - prev.inF) / fps)} s`);
      prev.outF = fr[i].inF;
    }
  }
  fr.forEach((f, i) => {
    if (f.outF <= f.inF) throw new FilmPlanError(`${shots[i].id}: edit length rounds to ${f.outF - f.inF} frame(s) at ${fps} fps`, "PLAN_INVALID");
  });
  const editF = fr.map((f) => f.outF - f.inF);

  // ── pass 3: transitions, handles, fades ──
  const n = shots.length;
  const dF = new Array(n).fill(0);
  const postIn = new Array(n).fill(0);
  const trIn = new Array(n);
  let fadeIn = null;
  let tailFadeIn = null;
  const minTr = COMPILE_DEFAULTS.minTransitionFrames;
  for (let i = 0; i < n; i++) {
    const t = shots[i].transition;
    const path = `shots[${i}].transition`;
    if (t.type === "cut") {
      trIn[i] = { type: "cut", durationSec: 0 };
      continue;
    }
    const want = Math.max(minTr, Math.round(t.durationSec * fps));
    if (i === 0) {
      const f = Math.min(want, editF[0]);
      fadeIn = { durationSec: r6(f / fps), color: t.type === "fadewhite" ? "white" : "black" };
      trIn[i] = { type: t.type, durationSec: r6(f / fps), fromColor: fadeIn.color };
      continue;
    }
    if (i === k) {
      // Into the silent tail: an element-local fade-in from black/white, like the first shot's — no handles, so the
      // music part's last take keeps its window. Its frames count as the shot's busy head (room for what follows).
      const f = Math.min(want, editF[k]);
      tailFadeIn = { durationSec: r6(f / fps), color: t.type === "fadewhite" ? "white" : "black" };
      trIn[i] = { type: t.type, durationSec: r6(f / fps), fromColor: tailFadeIn.color };
      postIn[i] = f;
      continue;
    }
    if (fr[i].inF !== fr[i - 1].outF) {
      warn(path, `${shots[i].id}: a ${t.type} cannot cross the gap before it — cut instead`);
      trIn[i] = { type: "cut", durationSec: 0 };
      continue;
    }
    // Centred on the cut: the incoming take shows pre = ⌊d/2⌋ frames before it, the outgoing take post = d − pre after.
    const roomA = editF[i - 1] - postIn[i - 1];
    let d = want;
    while (d >= minTr && (Math.floor(d / 2) > roomA || d - Math.floor(d / 2) > editF[i])) d--;
    if (d < minTr) {
      warn(path, `${shots[i].id}: no room for a ${t.type} between ${shots[i - 1].id} and ${shots[i].id} — cut instead`);
      trIn[i] = { type: "cut", durationSec: 0 };
      continue;
    }
    if (d !== want) warn(path, `${shots[i].id}: ${t.type} shortened from ${r3(want / fps)} s to ${r3(d / fps)} s to fit the neighbouring shots`);
    dF[i] = d;
    postIn[i] = d - Math.floor(d / 2);
    trIn[i] = { type: t.type, durationSec: r6(d / fps), xfade: t.xfade };
  }
  if (!fadeIn && p.edit.fadeInSec > 0) {
    const f = Math.min(Math.max(1, Math.round(p.edit.fadeInSec * fps)), editF[0]);
    fadeIn = { durationSec: r6(f / fps), color: "black" };
  }
  // A fade-out of `sec` on the end of shot j: never into the part of it a dissolve into it already uses.
  const fadeOutOn = (j, sec, path, what) => {
    const room = editF[j] - postIn[j];
    const want = Math.max(1, Math.round(sec * fps));
    const f = Math.max(1, Math.min(want, room));
    if (f !== want) warn(path, `${what} shortened to ${r3(f / fps)} s to fit ${j === n - 1 ? "the last shot" : `${shots[j].id}, the last shot before the tail`}`);
    return { durationSec: r6(f / fps), color: "black" };
  };
  let fadeOut = null;
  let musicFade = null;
  if (k > 0) {
    // music part: edit.fadeOutSec fades its last shot (element-local); the program fade-out is the tail's
    if (p.edit.fadeOutSec > 0) musicFade = fadeOutOn(k - 1, p.edit.fadeOutSec, "edit.fadeOutSec", "music fade-out");
    if (tail.fadeOutSec > 0) fadeOut = fadeOutOn(n - 1, tail.fadeOutSec, "edit.tail.fadeOutSec", "fade-out");
  } else if (p.edit.fadeOutSec > 0) {
    fadeOut = fadeOutOn(n - 1, p.edit.fadeOutSec, "edit.fadeOutSec", "fade-out");
  }
  const hiF = dF.slice();
  const hoF = dF.slice(1).concat([0]);

  // ── trims: the move is flown at trim.takeSec and the edit is a window of that one take ──
  const takeFr = shots.map((s, i) => {
    if (!isObj(s.trim)) return editF[i] + hiF[i] + hoF[i];
    const takeF = Math.round(s.trim.takeSec * fps);
    const lo = hiF[i];
    const hi = takeF - editF[i] - hoF[i];
    const hs = lo || hoF[i] ? ` + ${r3((lo + hoF[i]) / fps)} s of transition handles` : "";
    if (hi < lo) {
      throw new FilmPlanError(`${s.id}: the ${r3(editF[i] / fps)} s edit${hs} does not fit in its ${r3(takeF / fps)} s take (trim.takeSec) — shorten the duration (a longer trim.takeSec would slow the move)`,
        { code: "PLAN_INVALID", details: { shot: s.id, editSec: r6(editF[i] / fps), takeSec: r6(takeF / fps), handleSec: r6((lo + hoF[i]) / fps) } });
    }
    const want = Math.round(s.trim.inSec * fps);
    const inF = Math.min(Math.max(want, lo), hi);
    if (inF !== want) warn(`shots[${i}].trim.inSec`, `${s.id}: trim.inSec moved from ${r3(want / fps)} s to ${r3(inF / fps)} s so the ${r3(editF[i] / fps)} s edit${hs} stays inside the ${r3(takeF / fps)} s take`);
    hiF[i] = inF;
    hoF[i] = takeF - inF - editF[i];
    return takeF;
  });

  // ── items ──
  const preRollBase = Math.max(COMPILE_DEFAULTS.preRollFrames / fps, COMPILE_DEFAULTS.minPreRollSec);
  const items = shots.map((s, i) => {
    const site = siteById.get(s.site);
    const takeF = takeFr[i];
    const takeDuration = r6(takeF / fps);
    const preRollSec = r6(preRollBase + (isNum(site.settleSec) ? site.settleSec : 0));
    const sec = grid && !inTail(i) ? grid.sectionAt(fr[i].inF / fps + 1e-6) : null;
    const subject = s.subject;
    return {
      index: i,
      shotId: s.id,
      siteId: s.site,
      editIn: r6(fr[i].inF / fps),
      editOut: r6(fr[i].outF / fps),
      editDuration: r6(editF[i] / fps),
      editInFrame: fr[i].inF,
      editOutFrame: fr[i].outF,
      takeDuration,
      takeFrames: takeF,
      handleIn: r6(hiF[i] / fps),
      handleOut: r6(hoF[i] / fps),
      transitionIn: trIn[i],
      // element-local fades around the silent tail (absent otherwise: a plan without a tail compiles byte-identically)
      ...(i === k && tailFadeIn ? { fadeIn: tailFadeIn } : {}),
      ...(i === k - 1 && musicFade ? { fadeOut: musicFade } : {}),
      preRollSec,
      technique: s.technique,
      family: s.family,
      captureMode: s.capture.mode,
      snap: pos[i].snap,
      explicitStart: pos[i].explicit,
      requested: { duration: s.duration, start: s.start },
      trim: isObj(s.trim) ? { takeSec: takeDuration, inSec: r6(hiF[i] / fps), requestedInSec: s.trim.inSec } : null,
      section: sec ? { i: sec.i, label: sec.label, role: sec.role } : null,
      lyric: s.lyric ?? null,
      notes: s.notes ?? null,
      take: {
        shotId: s.id,
        siteId: s.site,
        technique: s.technique,
        family: s.family,
        spec: shotSpec(s, takeDuration),
        subject: subject ?? null,
        path: s.path ?? (subject && subject.kind === "path" ? subject.points : null),
        route: s.route ?? null,
        standingOrder: s.standingOrder,
        goal: typeof s.goal === "string" ? s.goal : null,
        pilot: s.pilot,
        capture: { mode: s.capture.mode, fps, width: p.format.width, height: p.format.height },
        look: s.look,
        actor: s.actor ?? null,
        cell: s.cell ?? (site.indoor ? site.cell : null),
        indoor: site.indoor === true,
        anchor: site.anchor,
        editOffsetSec: r6(hiF[i] / fps),
        preRollSec,
        showAvatar: (subject !== null && isObj(subject) && subject.kind === "player") || (s.actor !== null && s.actor !== undefined),
        overlay: isObj(s.overlay) ? JSON.parse(JSON.stringify(s.overlay)) : null,
      },
    };
  });

  // ── shooting schedule ──
  const firstUse = [];
  for (const s of shots) if (!firstUse.includes(s.site)) firstUse.push(s.site);
  const order = greedySiteOrder(firstUse.map((id) => ({ id, anchor: siteById.get(id).anchor })));
  const schedule = order.map(({ id, travelM }) => {
    const site = siteById.get(id);
    const its = items.filter((it) => it.siteId === id);
    const pts = [];
    const seen = new Set();
    const addPt = (q) => {
      if (!Array.isArray(q) || q.length !== 3 || !q.every(isNum)) return;
      const k = q.map((x) => r3(x)).join(",");
      if (!seen.has(k)) { seen.add(k); pts.push(q.slice()); }
    };
    addPt(site.anchor);
    if (!site.indoor) {
      for (const s of shots.filter((x) => x.site === id)) {
        if (isObj(s.subject) && s.subject.kind === "point") addPt(s.subject.pos);
        if (isObj(s.subject) && s.subject.kind === "path") s.subject.points.forEach(addPt);
        if (Array.isArray(s.path)) s.path.forEach(addPt);
        if (isObj(s.actor) && Array.isArray(s.actor.moveTo)) addPt(s.actor.moveTo);
      }
    }
    return {
      siteId: id,
      name: site.name ?? id,
      teleport: site.teleport,
      // sent by `film shoot` before the teleport (only when set: a plan without prime compiles byte-identically)
      ...(Array.isArray(site.prime) && site.prime.length ? { prime: site.prime.map((c) => String(c).trim()) } : {}),
      anchor: site.anchor,
      cell: site.cell,
      indoor: site.indoor === true,
      travelM,
      ready: {
        lbKeys: site.lbKeys.map((k) => (parseCellId(k) & 0xffff0000) >>> 0),
        interiorLb: site.interiorLb !== null ? (parseCellId(site.interiorLb) & 0xffff0000) >>> 0 : null,
        settleSec: site.ready.settleSec,
        timeoutSec: site.ready.timeoutSec,
      },
      prewarm: { points: pts, radius: COMPILE_DEFAULTS.prewarmRadius },
      shots: its.map((it) => it.shotId),
      takeSec: r6(its.reduce((a, it) => a + it.takeDuration + it.preRollSec, 0)),
    };
  });

  const totalF = fr[n - 1].outF;
  const duration = r6(totalF / fps);
  const musicEndF = k > 0 ? fr[k - 1].outF : totalF;
  const musicSec = k > 0 ? r6(musicEndF / fps) : duration;
  if (grid && grid.endSec !== null && musicSec > grid.endSec + 1 / fps) {
    const m = musicSec;
    warn("shots", k > 0
      ? `the music part (${r3(m)} s, before the silent tail at ${shots[k].id}) runs ${r3(m - grid.endSec)} s past the end of the song (${r3(grid.endSec)} s after offset)`
      : `the edit (${r3(duration)} s) runs ${r3(duration - grid.endSec)} s past the end of the song (${r3(grid.endSec)} s after offset)`);
  }

  return {
    version: TIMELINE_VERSION,
    title: p.title,
    kind: p.kind ?? null,
    fps,
    width: p.format.width,
    height: p.format.height,
    duration,
    frames: totalF,
    song: isObj(p.song) || song
      ? {
        file: isObj(p.song) ? p.song.file ?? null : null,
        analysis: isObj(p.song) ? p.song.analysis ?? null : null,
        offsetSec: offset,
        bpm: song && isObj(song.tempo) && isNum(song.tempo.bpm) ? song.tempo.bpm : null,
        durationSec: song && isNum(song.durationSec) ? song.durationSec : null,
      }
      : null,
    fadeIn,
    fadeOut,
    ...(k > 0 ? { musicEnd: { sec: r6(musicEndF / fps), frame: musicEndF, fadeOutSec: musicFade ? musicFade.durationSec : 0 } } : {}),
    items,
    schedule,
    warnings,
    source: { planHash: hashString(JSON.stringify(p)).toString(16).padStart(8, "0") },
  };
}

/** "4 min 05 s" style duration. */
function humanSec(s) {
  const t = Math.round(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m) return `${m} min ${String(sec).padStart(2, "0")} s`;
  return `${sec} s`;
}

/**
 * Rough wall-clock estimate of shooting a compiled timeline: one teleport + readiness settle per schedule entry and
 * per `prime` command of it (film shoot sends each before the site teleport, with its own readiness gate), plus
 * every take's frames (take + pre-roll) rendered at `stepFps` for stepped takes, or in real time for realtime
 * takes. No rehearsals, retakes, muxing or boot are included.
 * @param {object} timeline compiled Timeline
 * @param {{teleportSec?:number, settleSec?:number, stepFps?:number}} [opts]
 * @returns {{totalSec:number, teleports:number, primes:number, takes:number, frames:number, teleportTotalSec:number,
 *   settleTotalSec:number, renderTotalSec:number, perSite:{siteId:string, sec:number, shots:string[]}[],
 *   perShot:{shotId:string, mode:string, frames:number, sec:number}[], text:string}} `teleports` counts the prime
 *   teleports too (`primes` of them)
 */
export function estimateShootTime(timeline, opts = {}) {
  const { teleportSec = 12, settleSec = 5, stepFps = 8 } = opts || {};
  if (!isObj(timeline) || !Array.isArray(timeline.items) || !Array.isArray(timeline.schedule) || !isNum(timeline.fps)) {
    throw new FilmPlanError("estimateShootTime: not a compiled timeline", "TIMELINE_INVALID");
  }
  if (!(stepFps > 0)) throw new FilmPlanError(`estimateShootTime: stepFps must be > 0 (got ${stepFps})`, "BAD_ARGUMENT");
  const fps = timeline.fps;
  const perShot = timeline.items.map((it) => {
    const span = it.takeDuration + it.preRollSec;
    const frames = Math.ceil(span * fps - 1e-6);
    const sec = it.captureMode === "realtime" ? span : frames / stepFps;
    return { shotId: it.shotId, mode: it.captureMode, frames, sec: r3(sec) };
  });
  const byShot = new Map(perShot.map((x) => [x.shotId, x]));
  const primesOf = (e) => (Array.isArray(e.prime) ? e.prime.length : 0);
  const perSite = timeline.schedule.map((e) => ({
    siteId: e.siteId,
    shots: e.shots.slice(),
    sec: r3((1 + primesOf(e)) * (teleportSec + settleSec) + e.shots.reduce((a, id) => a + (byShot.get(id)?.sec ?? 0), 0)),
  }));
  const primes = timeline.schedule.reduce((a, e) => a + primesOf(e), 0);
  const teleports = timeline.schedule.length + primes;
  const renderTotalSec = r3(perShot.reduce((a, x) => a + x.sec, 0));
  const frames = perShot.reduce((a, x) => a + x.frames, 0);
  const totalSec = r3(teleports * (teleportSec + settleSec) + renderTotalSec);
  const stepped = perShot.filter((x) => x.mode === "stepped").length;
  return {
    totalSec,
    teleports,
    primes,
    takes: perShot.length,
    frames,
    teleportTotalSec: r3(teleports * teleportSec),
    settleTotalSec: r3(teleports * settleSec),
    renderTotalSec,
    perSite,
    perShot,
    text: `≈ ${humanSec(totalSec)} wall-clock: ${teleports} teleport(s)${primes ? ` (${primes} of them site.prime)` : ""} × (${teleportSec} s + ${settleSec} s settle), ` +
      `${perShot.length} take(s) / ${frames} frames (${stepped} stepped at ${stepFps} fps, ${perShot.length - stepped} realtime)`,
  };
}
