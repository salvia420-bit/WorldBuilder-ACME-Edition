// tools/film/lib/shoot.mjs — walk a compiled shooting schedule on the live page: teleport → readiness → prewarm →
// per shot prepare → [rehearse] → shoot while draining → mux → take report → keep or retake.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) shoots by SITE because a teleport costs ≈10 s and the hidden player
// is the streaming dolly (SPEC §0). The compiler (tools/film/plan/compile.mjs) already grouped the shots into
// `timeline.schedule` (fewest teleports); this module executes it, and its structure is the guarantee that NOTHING
// is recorded across a teleport: the only teleport is the first step of a schedule entry, before any take of that
// entry starts, and a take's drain loop finishes before the next step runs. A failed take can leave the PAGE's
// take running (a drain or disk error, an evaluate timeout), so after any failure inside the page part of an
// attempt the CLI calls __film.abort() and waits until __film.status() is idle (settlePage), and before every
// teleport it checks status again (aborting a leftover take); the abort is re-sent on every poll that still finds
// the page busy (≤ PAGE_ABORT_MAX), because one that lands before the take player's run has started is a no-op.
// A page that will not go idle is never teleported — the remaining shots fail at stage 'busy' instead.
//
// Page issues: prepare's validation issues (incl. the drone/fpv flight check's `overspeed` with `limitedBy`,
// `minDurationSec`, `minDurationVerified`, `durationHelps` and the dry-flown `maxGapM`), `flight`, `warnings`, and
// the same blocks on the rehearse result and the take report (pageIssuesOf) — plus `tracking-gap` when a flown
// run's realised `flight.tracking` trailed its planned path by more than FLIGHT_GAP_WARN_M — print one warning line
// each: a page issue ONCE PER SHOT (however many stages and attempts report it), a `tracking-gap` once PER RUN whose
// gap differs (the rehearsal, the take and each retake: it is keyed by its message and t). They go into
// reports/<shot>.json (`issues`, `validation`, `flight`), every shoot-log row of the shot (`issues`),
// reports/<shot>.rehearsal.json and judgeInput (`issues`, `flight`). They never fail or retake a take (a retake
// replays the same plan).
//
// Per site: settlePage → [prime] → teleport → readiness gate → world.prewarm, which is BEST-EFFORT (the readiness
// gate has already passed): an incomplete or failed prewarm only warns, adds a `stage:'prewarm'` row to
// shoot-log.jsonl and a `prewarm` note to that site's take reports. A site whose teleport/readiness throws records
// each of its shots as a failure (stage 'site') and the schedule goes on; only usage errors (no __film, no method)
// abort the run.
//
// PRIME (`site.prime` → schedule entry `prime: ['@teleloc …', …]`): the server only sends a player the creatures
// in the cells its current cell can see (ACE PVS), so a dungeon run filmed far from the hidden player shows empty
// halls. Before the site teleport — after settlePage, so no take runs — each prime command is sent through the same
// goAndWait path as a teleport (readiness = the entry's settle/timeout + readyTargetsForCommand(cmd)), walking the
// player along the route so every creature on it streams in; the site teleport then stands the player at the site.
// Each prints a progress line (stderr), adds an `event:'prime'` row to shoot-log.jsonl and a `prime` note to the
// site's take reports; a failing or not-ready prime only WARNS (the site still runs). Counted in `primes`.
//
// In-site HOPS (`hopM`, `film shoot --hop`, default STAND_HOP_M): grass is drawn around the hidden player
// (terrain_grass: dense to 48 m) and the server only sends the objects near it (NPCs, Life Stones, portals), so
// before each OUTDOOR shot whose camera path (standPointOf: built offline like `plan validate --dry`, its
// horizontal centroid) lies more than hopM from the player, the player is moved there with `@teleloc` (ground +
// HOP_LIFT_M) and the readiness gate runs again — between takes, after settlePage, so nothing is recorded across
// it. Shots with an actor cue or a visible avatar (the site teleport placed the player on purpose) never hop. A hop
// that fails or is not ready only warns (the shot is taken from where the player is); it adds an `event:'hop'` row
// to shoot-log.jsonl and a `hop` note to that shot's report.
//
// Per take (attempt k = 0 … retakes):
//   1. __film.world.avatar(true) when take.showAvatar (and false again afterwards, even on failure)
//   2. __film.prepare(item.take)  (locked: {…take, table: realised table of the rehearsal})
//   3. first attempt only, when needsRehearsal(): broker.setDecideOptions(stepped) — a rehearsal is ALWAYS a
//      stepped run (the page waits 15 s per decision), whatever the shot's capture mode or the previous shot left
//      set — then __film.rehearse({fps}) → reports/<shot>.rehearsal.json + reports/<shot>.pilot.jsonl, then
//      prepare again
//   4. broker.setDecideOptions(DECIDE_OPTIONS[captureMode]) for the take itself (realtime {timeoutMs:1200,
//      maxRetries:0} | stepped {timeoutMs:4000, maxRetries:2})
//   4b. pageEnv: a read-only snapshot of the page's look settings (PAGE_ENV_FN: redacted URL, quality preset, storm
//      state, cloud coverage / weather / stormScan / waterSheenFade / filmProps URL values, terrain water/IBL
//      uniforms) → `pageEnv` in the take report; a failing snapshot is null and never fails the take
//   5. __film.shoot({fps, width, height, codec, bitrate, mode: item.captureMode, locked}) WHILE draining
//      __film.recorder.drain({maxBytes: 8 MiB}) into takes/<stem>.h264 | .ivf | .frames/ (lib/drain.mjs); any
//      failure in steps 2–5 → __film.abort() + wait for an idle page, then the error goes on
//   6. ffmpeg mux → takes/<stem>.mp4 (lib/ffmpeg.mjs muxArgv)
//   7. take report = page report + file stats + drained frame count + page issues; keepOrRetake(jev | null)
//   8. broker.dumpTelemetry(reports/<shot>.jev.jsonl, {since: mark taken when the shot started}) — that shot's
//      broker entries only (its rehearsal and every attempt), never an earlier shot's
// Stems: attempt 0 → <shot>, attempt k → <shot>.retake<k>. When a retake is kept, the files move so that
// takes/<shot>.mp4 is ALWAYS the kept take (the first attempt becomes <shot>.retake0.mp4). reports/<shot>.json is
// the kept take's report (+ verdict + attempts); every attempt is appended to reports/shoot-log.jsonl.
// A take is retaken (up to --retakes) when the verdict is not `keep` with band 'act'. A RETAKE that fails keeps the
// attempts already recorded (the report lists it under `failedAttempts`, the shoot-log gets an ok:false row); a
// failure of the first attempt fails the shot.

import nodeFs from "node:fs";
import path from "node:path";

import { FilmCliError, EXIT, jsonReplacer } from "./args.mjs";
import { DRAIN_MAX_BYTES, createTakeSink, drainTake } from "./drain.mjs";
import { muxArgv, runFfmpeg } from "./ffmpeg.mjs";
import { appendJsonl, writeJsonFile } from "./project.mjs";
import { evaluateWithTimeout, filmCall, filmCallWith, goAndWait, readyTargetsForCommand } from "./session.mjs";
import { localFromWorld, telelocCmd } from "../../../scene3d/film/core/units.js";

/** Broker per-call limits by capture mode (SPEC §3.2: the page waits 1.5 s realtime, 15 s stepped). */
export const DECIDE_OPTIONS = Object.freeze({
  realtime: Object.freeze({ timeoutMs: 1200, maxRetries: 0 }),
  stepped: Object.freeze({ timeoutMs: 4000, maxRetries: 2 }),
});

/**
 * How long to wait for the page to go idle after __film.abort() (cooperative: the take stops at its next frame,
 * and a stepped frame can wait up to 15 s for a JEV decision): one decision wait plus a wide margin.
 */
export const PAGE_IDLE_WAIT_MS = 90_000;

/**
 * At most this many __film.abort() calls per settlePage. The abort is re-sent on every poll that still finds the
 * page busy, because an abort that lands before the page's take player has started its run (index.js already has
 * busy='shoot' but is still in ready() / clean-frame setup) is a no-op on the page and would otherwise be lost.
 */
export const PAGE_ABORT_MAX = 30;

/**
 * Runs in the page (self-contained, read-only, never throws): the look settings a take is recorded with, for its
 * report (`pageEnv`) — so a grey, stormy or sheen-less take can be traced to its boot URL / page state:
 * `url` (location.href with password / account values replaced by [redacted]), `quality` (window.__quality.preset),
 * `isStorm` (window.__getWeather().is_storm), the URL values of cloudCoverage / cloudWeather / clouds / stormScan /
 * waterSheenFade / filmProps (null when absent), and `water` ({materials, waterEnvEnabled, iblEnabled}: whether ANY
 * of liveScene3d.terrainMaterials has uWaterEnvEnabled / uIblEnabled on; null when unavailable). Unknown → null.
 */
export const PAGE_ENV_FN = () => {
  const w = typeof window !== "undefined" ? window : {};
  const out = {
    url: null, quality: null, isStorm: null, cloudCoverage: null, cloudWeather: null, clouds: null, stormScan: null,
    waterSheenFade: null, filmProps: null, water: null,
  };
  let href = "";
  try {
    href = w.location && typeof w.location.href === "string" ? w.location.href : "";
  } catch (_) {
    href = "";
  }
  if (href) {
    out.url = href.replace(/([?&#](?:password|pass|pw|account)=)[^&#]*/gi, "$1[redacted]");
    try {
      const q = new URL(href).searchParams;
      for (const k of ["cloudCoverage", "cloudWeather", "clouds", "stormScan", "waterSheenFade", "filmProps"]) out[k] = q.has(k) ? q.get(k) : null;
    } catch (_) {
      // keep the nulls
    }
  }
  try {
    const qp = w.__quality;
    out.quality = qp && typeof qp.preset === "string" ? qp.preset : null;
  } catch (_) {
    out.quality = null;
  }
  try {
    const st = typeof w.__getWeather === "function" ? w.__getWeather() : null;
    out.isStorm = st && typeof st.is_storm === "boolean" ? st.is_storm : null;
  } catch (_) {
    out.isStorm = null;
  }
  try {
    const mats = w.liveScene3d && Array.isArray(w.liveScene3d.terrainMaterials) ? w.liveScene3d.terrainMaterials : null;
    if (mats) {
      let n = 0, hasWater = false, hasIbl = false, waterOn = false, iblOn = false;
      for (const m of mats) {
        const u = m && m.uniforms;
        if (!u) continue;
        n++;
        if (u.uWaterEnvEnabled) {
          hasWater = true;
          if (Number(u.uWaterEnvEnabled.value) > 0.5) waterOn = true;
        }
        if (u.uIblEnabled) {
          hasIbl = true;
          if (Number(u.uIblEnabled.value) > 0.5) iblOn = true;
        }
      }
      out.water = { materials: n, waterEnvEnabled: hasWater ? waterOn : null, iblEnabled: hasIbl ? iblOn : null };
    }
  } catch (_) {
    out.water = null;
  }
  return out;
};

/** PAGE_ENV_FN on the page, or null when the evaluate fails (never throws: a take never fails because of it). */
async function pageEnvOf(page) {
  try {
    const r = await evaluateWithTimeout(page, PAGE_ENV_FN, undefined, { timeoutMs: 15_000, what: "page env" });
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

/** Drone techniques that fly low and close to obstacles: rehearsed by default. */
const OBSTACLE_DRONE_RE = /(canyon-run|flythrough|terrain-skim|fly-by|chase|lead|side-track|pass-over)/;

/**
 * Pick the schedule entries and shots to shoot.
 * @param {object} timeline compiled Timeline
 * @param {{site?: string|null, shot?: string|null, all?: boolean}} sel `shot` may be a comma list
 * @returns {Array<{entry: object, shots: string[]}>} in schedule order
 */
export function selectSchedule(timeline, { site = null, shot = null, all = false } = {}) {
  const schedule = Array.isArray(timeline?.schedule) ? timeline.schedule : [];
  const modes = [Boolean(site), Boolean(shot), Boolean(all)].filter(Boolean).length;
  if (modes !== 1) throw new FilmCliError("choose exactly one of --site=<id>, --shot=<id>[,<id>…] or --all", { exitCode: EXIT.USAGE, code: "USAGE" });
  if (all) return schedule.map((entry) => ({ entry, shots: entry.shots.slice() }));
  if (site) {
    const entry = schedule.find((e) => e.siteId === site);
    if (!entry) throw new FilmCliError(`no schedule entry for site '${site}' (have: ${schedule.map((e) => e.siteId).join(", ")})`, { exitCode: EXIT.USAGE, code: "USAGE" });
    return [{ entry, shots: entry.shots.slice() }];
  }
  const wanted = String(shot).split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set(schedule.flatMap((e) => e.shots));
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length) throw new FilmCliError(`unknown shot id(s): ${unknown.join(", ")}`, { exitCode: EXIT.USAGE, code: "USAGE" });
  return schedule
    .map((entry) => ({ entry, shots: entry.shots.filter((s) => wanted.includes(s)) }))
    .filter((x) => x.shots.length > 0);
}

/**
 * Should this shot be rehearsed before its first take? 'always' / 'never' force it; 'auto' rehearses fpv shots,
 * indoor (dungeon) sites and low/close drone moves (canyon-run, flythrough, terrain-skim, fly-by, chase, lead,
 * side-track, pass-over).
 * @param {object} item timeline item
 * @param {object} entry schedule entry
 * @param {'auto'|'always'|'never'} [mode]
 * @returns {boolean}
 */
export function needsRehearsal(item, entry, mode = "auto") {
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (item?.family === "fpv") return true;
  if (entry?.indoor === true || item?.take?.indoor === true) return true;
  if (item?.family === "drone" && OBSTACLE_DRONE_RE.test(String(item?.technique ?? ""))) return true;
  return false;
}

/** File stem of attempt k. */
export function takeStem(shotId, attempt) {
  return attempt === 0 ? shotId : `${shotId}.retake${attempt}`;
}

// ── page issues ─────────────────────────────────────────────────────────────────────────────────────────────
// The page reports problems with a take that are not errors: prepare's `validation` ({ok, counts, issues[{code,
// t, message, …}], error}) — including the drone/fpv flight check's `overspeed` issue with `limitedBy` ('speed' |
// 'acceleration'), `minDurationSec`, the shortest duration the flying preset can fly the path in, and
// `minDurationVerified` (true: dry-flown within the tolerance there; null: not verified — `minDurationSec`, when
// set, is an estimate; false: no duration helps), `durationHelps` (false: a longer duration will not slow the
// move) and `maxGapM` (the DRY-flown gap at prepare) — and `flight` ({preset, vmax, peakSpeed, lengthM, overspeed,
// limitedBy, minDurationSec, minDurationVerified, minDurationCheck, durationHelps, dryFlight, …}); scout/prepare
// may add `warnings` (strings). The rehearse result and the take report may carry the same blocks
// (scene3d/film/runtime/take_player.js), and their `flight.tracking` ({frames, maxGapM, maxGapT, endGapM}) is how
// far the flown craft really trailed its planned path. The CLI reads them defensively (any of them may be absent,
// also nested under `prepared` / `preflight` / `checks`…), prints one warning per issue and records them in the
// take report, shoot-log.jsonl and judgeInput. They never fail a take: a retake replays the same plan.

/** Keys under which a page result may nest its prepare-time checks (the result itself is read first). */
const ISSUE_HOLDERS = Object.freeze(["prepared", "prepare", "preflight", "plan", "summary", "checks"]);
/**
 * Scalar fields of a page issue the CLI keeps besides code / message / t. `maxGapM` is the DRY-flown gap on the
 * page's `overspeed` and the REALISED gap on the CLI's `tracking-gap`.
 */
const ISSUE_FIELDS = Object.freeze(["preset", "vmax", "peakSpeed", "lengthM", "limitedBy", "minDurationSec", "minDurationVerified", "durationHelps", "maxGapM", "endGapM", "severity", "level"]);
/** ISSUE_FIELDS whose explicit null is a page value and is kept (minDurationVerified null: not verified). */
const ISSUE_NULLABLE = new Set(["minDurationVerified"]);

/**
 * A flown run whose craft trailed its planned path (`flight.tracking.maxGapM` / `endGapM`, the distance from the
 * re-anchored nominal) by MORE than this many metres gets a `tracking-gap` issue. A move the preset can fly trails
 * by well under a metre. The page's prepare-time flight check PREDICTS: it dry-flies the planned nominal at 10 fps
 * and flags a gap above 1 m (`overspeed`, speed- or acceleration-limited). This is the MEASURED gap of the rehearsal
 * or take, the safety net when the prediction misses: the dry flight samples the gap only at 10 Hz (a 30 / 60 fps
 * run can trail further — up to about 0.6 m more on a fast fpv dive dry-flown at 0.65 m), and it flies the nominal
 * built against the subject's prepare-time reference track, not the path re-anchored every frame to a LIVE subject
 * (a subject turning faster than the craft can swing round it: a U-turn at 90°/s leaves a cinema chase about 2.3 m
 * behind, the heavy preset trails about 3 m on a quarter turn). A flown carry rig's warning says so (liveCarry).
 */
export const FLIGHT_GAP_WARN_M = 2;

/** Appended to a `tracking-gap` of a flown carry rig that followed a live subject. */
const LIVE_CARRY_GAP_HINT = "; it followed a live subject, and a turn sharper than the craft can swing round (a U-turn at 90°/s) leaves it behind too: reshoot with a gentler subject move (a slower or wider turn)";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function issueFrom(raw, stage, defaultCode) {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) {
    const message = typeof raw === "string" ? raw : errText(raw);
    return message ? { code: defaultCode, message, t: null, stages: [stage] } : null;
  }
  const code = typeof raw.code === "string" && raw.code ? raw.code : defaultCode;
  const message = typeof raw.message === "string" && raw.message ? raw.message : raw.message != null ? errText(raw.message) : code;
  const out = { code, message, t: finiteOrNull(raw.t), stages: [stage] };
  for (const k of ISSUE_FIELDS) {
    const v = raw[k];
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (v === null && ISSUE_NULLABLE.has(k) && Object.prototype.hasOwnProperty.call(raw, k)) out[k] = null;
  }
  return out;
}

// A `flight` block that says overspeed but no validation issue for it (the take report may carry only the block).
// Worded like the page's own issue (take_player.js overspeedIssue): a speed- or an acceleration-limited move
// (`limitedBy`), the dry-flown gap (`dryFlight.maxGapM` → `maxGapM`), and a `minDurationSec` that is either
// verified by a dry flight (`minDurationVerified` true / `minDurationCheck` 'verified') or an estimate (null /
// 'unverified'); a block that says neither gets no qualifier.
function overspeedFromFlight(f, stage) {
  const preset = typeof f.preset === "string" && f.preset ? f.preset : null;
  const vmax = finiteOrNull(f.vmax);
  const amax = finiteOrNull(f.amax);
  const peak = finiteOrNull(f.peakSpeed);
  const lengthM = finiteOrNull(f.lengthM);
  const minD = finiteOrNull(f.minDurationSec);
  const helps = typeof f.durationHelps === "boolean" ? f.durationHelps : null;
  const limitedBy = typeof f.limitedBy === "string" && f.limitedBy ? f.limitedBy : null;
  const hasVerified = Object.prototype.hasOwnProperty.call(f, "minDurationVerified") && (typeof f.minDurationVerified === "boolean" || f.minDurationVerified === null);
  const verified = f.minDurationVerified === true || f.minDurationCheck === "verified";
  const estimate = !verified && ((hasVerified && f.minDurationVerified === null) || f.minDurationCheck === "unverified");
  const tol = finiteOrNull(f.gapToleranceM);
  const dry = isObj(f.dryFlight) ? f.dryFlight : null;
  const dryGap = dry ? finiteOrNull(dry.maxGapM) : null;
  const dryAccel = dry ? finiteOrNull(dry.peakAccel) : null;
  const drone = preset ? `the '${preset}' drone` : "the drone";
  const speed = peak !== null ? `peaks at ${peak.toFixed(1)} m/s` : "is faster than the flight caps";
  const over = lengthM !== null ? ` over ${lengthM.toFixed(0)} m` : "";
  const trail = dryGap !== null ? `dry-flown, the craft trails the planned path by up to ${dryGap.toFixed(1)} m` : null;
  const note = verified
    ? ` (dry-flown within ${tol !== null ? `${tol} m` : "the check's tolerance"} there)`
    : estimate ? " (an estimate: not dry-flown within the check's budget)" : "";
  const fix = minD !== null
    ? `use duration ≥ ${minD} s${note}`
    : helps === false
      ? "a longer duration will not help (the move's speed comes from its params, its ease or the subject it follows): lower params.speed, use ease 'linear' or give a shorter path"
      : "use a longer duration or a shorter, straighter path";
  let message;
  if (limitedBy === "acceleration") {
    const cap = `${drone}'s ${vmax !== null ? `${vmax} m/s` : "top speed"}`;
    const within = peak !== null ? ` peaks at ${peak.toFixed(1)} m/s${over}, within ${cap}, but` : `${over} stays within ${cap} but`;
    const asks = dryAccel !== null && dryAccel > 0 ? `; the path asks for up to ${dryAccel.toFixed(1)} m/s²` : "";
    const limit = amax !== null ? ` (≤ ${amax} m/s²${asks})` : "";
    message = `the move${within} turns or changes speed harder than it can follow${limit}: ${trail ?? "the flown camera falls behind the planned path"}${tol !== null ? ` (tolerance ${tol} m)` : ""}; ${fix}`;
  } else {
    const caps = `${drone}${vmax !== null ? ` flies ≤ ${vmax} m/s` : " cannot keep up"}`;
    message = `the move ${speed}${over}, but ${caps}: the flown camera falls behind the planned path and ends short of it${trail ? ` (${trail})` : ""}; ${fix}`;
  }
  const out = { code: "overspeed", message, t: null, stages: [stage] };
  if (preset) out.preset = preset;
  if (vmax !== null) out.vmax = vmax;
  if (peak !== null) out.peakSpeed = peak;
  if (lengthM !== null) out.lengthM = lengthM;
  if (limitedBy !== null) out.limitedBy = limitedBy;
  if (minD !== null) out.minDurationSec = minD;
  if (hasVerified) out.minDurationVerified = f.minDurationVerified;
  if (helps !== null) out.durationHelps = helps;
  if (dryGap !== null) out.maxGapM = dryGap;
  return out;
}

// A flown run's realised tracking (`flight.tracking`) that trailed the plan by more than FLIGHT_GAP_WARN_M, else null.
// `liveCarry`: the run re-anchored a carry rig to a live subject (`liveSubject.mode` 'carry' on the same result), so
// a subject turning faster than the craft can swing round it is a cause too (SPEC §5.2 Live subjects).
function trackingGapFromFlight(f, stage, liveCarry = false) {
  const tr = isObj(f.tracking) ? f.tracking : null;
  if (!tr) return null;
  const maxGap = finiteOrNull(tr.maxGapM);
  const endGap = finiteOrNull(tr.endGapM);
  const worst = Math.max(maxGap ?? -Infinity, endGap ?? -Infinity);
  if (!(worst > FLIGHT_GAP_WARN_M)) return null;
  const preset = typeof f.preset === "string" && f.preset ? f.preset : null;
  const drone = preset ? `the '${preset}' drone` : "the drone";
  const fix = f.durationHelps === false
    ? "a longer duration will not help: lower params.speed, use ease 'linear' or give a shorter path"
    : `use a longer duration, ease 'linear' or a shorter, straighter path${preset === "fpv" ? "" : " (or pilot.flightPreset 'fpv')"}`;
  const out = {
    code: "tracking-gap",
    message: `the flown camera trailed its planned path by up to ${worst.toFixed(1)} m${endGap !== null ? ` and ended ${endGap.toFixed(1)} m from it` : ""} (warned above ${FLIGHT_GAP_WARN_M} m): the move asks for more speed or acceleration than ${drone} has, so the shot is framed off the plan; ${fix}${liveCarry ? LIVE_CARRY_GAP_HINT : ""}`,
    t: finiteOrNull(tr.maxGapT),
    stages: [stage],
  };
  if (preset) out.preset = preset;
  if (maxGap !== null) out.maxGapM = maxGap;
  if (endGap !== null) out.endGapM = endGap;
  return out;
}

function countsText(counts) {
  if (!isObj(counts)) return "";
  const parts = Object.entries(counts).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k} ×${n}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Same finding? One flight check per take, so every `overspeed` of one preset is the same issue. */
function sameIssue(a, b) {
  if (a.code !== b.code) return false;
  if (a.code === "overspeed") return a.preset === undefined || b.preset === undefined || a.preset === b.preset;
  return a.message === b.message && (a.t ?? null) === (b.t ?? null);
}

/**
 * Merge issues into `into` (mutated, returned): a repeat adds its stages and fills missing fields.
 * @param {object[]} into
 * @param {object[]|null|undefined} list
 * @returns {object[]}
 */
export function mergeIssues(into, list) {
  for (const i of Array.isArray(list) ? list : []) {
    if (!isObj(i) || typeof i.code !== "string") continue;
    const stages = Array.isArray(i.stages) ? i.stages : [];
    const have = into.find((x) => sameIssue(x, i));
    if (!have) {
      into.push({ ...i, stages: stages.slice() });
      continue;
    }
    for (const s of stages) if (!have.stages.includes(s)) have.stages.push(s);
    for (const k of ISSUE_FIELDS) if (have[k] === undefined && i[k] !== undefined) have[k] = i[k];
  }
  return into;
}

/**
 * The validation / flight-check issues and warnings a page result reports (prepare summary, rehearse result, take
 * report), normalised to `{code, message, t, stages: [stage], preset?, vmax?, peakSpeed?, lengthM?, limitedBy?,
 * minDurationSec?, minDurationVerified? (true | false | null), durationHelps?, maxGapM?, endGapM?}` (`maxGapM`: the
 * dry-flown gap on `overspeed`, the realised gap on `tracking-gap`). Reads `validation.issues`, `validation.error`,
 * `validation.ok === false` (no issue listed), `flight` / `flightCheck` with `overspeed: true` (→ `overspeed`) or a
 * realised `tracking` gap above FLIGHT_GAP_WARN_M (→ `tracking-gap`, t = maxGapT; a run with a different gap is a
 * separate issue, so the rehearsal's and the take's are both kept), `issues` and `warnings`, on the result and
 * under `prepared`, `prepare`, `preflight`, `plan`, `summary`, `checks`. Absent or malformed blocks give no issue;
 * never throws.
 * @param {unknown} result
 * @param {'prepare'|'rehearse'|'shoot'|string} stage
 * @returns {object[]}
 */
export function pageIssuesOf(result, stage) {
  const out = [];
  if (!isObj(result)) return out;
  for (const h of [result, ...ISSUE_HOLDERS.map((k) => result[k]).filter(isObj)]) {
    const found = [];
    const v = h.validation;
    if (isObj(v)) {
      const listed = Array.isArray(v.issues) ? v.issues.map((i) => issueFrom(i, stage, "invalid")).filter(Boolean) : [];
      found.push(...listed);
      if (v.error !== undefined && v.error !== null) {
        found.push({ code: "validation-error", message: `the page could not validate the take: ${errText(v.error)}`, t: null, stages: [stage] });
      } else if (v.ok === false && listed.length === 0) {
        found.push({ code: "invalid", message: `the take failed validation${countsText(v.counts)}`, t: null, stages: [stage] });
      }
    }
    for (const key of ["flight", "flightCheck"]) {
      if (!isObj(h[key])) continue;
      if (h[key].overspeed === true) found.push(overspeedFromFlight(h[key], stage));
      const gap = trackingGapFromFlight(h[key], stage, isObj(h.liveSubject) && h.liveSubject.mode === "carry");
      if (gap) found.push(gap);
    }
    if (Array.isArray(h.issues)) found.push(...h.issues.map((i) => issueFrom(i, stage, "issue")).filter(Boolean));
    if (Array.isArray(h.warnings)) found.push(...h.warnings.map((w) => issueFrom(w, stage, "warning")).filter(Boolean));
    mergeIssues(out, found);
  }
  return out;
}

/** The first `flight` (or `flightCheck`) block among page results (and their nested holders), else null. */
export function flightOf(...results) {
  for (const r of results) {
    if (!isObj(r)) continue;
    for (const h of [r, ...ISSUE_HOLDERS.map((k) => r[k]).filter(isObj)]) {
      const f = isObj(h.flight) ? h.flight : isObj(h.flightCheck) ? h.flightCheck : null;
      if (f) return { ...f };
    }
  }
  return null;
}

/** prepare's `validation` without its issue list (the issues go to `issues`): `{ok, counts, error?}` or null. */
function validationSummary(prep) {
  const v = isObj(prep) ? prep.validation : null;
  if (!isObj(v)) return null;
  return { ok: typeof v.ok === "boolean" ? v.ok : null, counts: isObj(v.counts) ? { ...v.counts } : null, ...(v.error != null ? { error: errText(v.error) } : {}) };
}

/**
 * One warning line for a page issue.
 * @param {string} shotId
 * @param {object} issue from pageIssuesOf
 * @returns {string}
 */
export function issueLine(shotId, issue) {
  const stages = Array.isArray(issue.stages) && issue.stages.length ? issue.stages.join("/") : "page";
  const when = Number.isFinite(issue.t) ? ` at t=${+issue.t.toFixed(3)} s` : "";
  // The page's / fallback's own message names the duration (and says "an estimate" when it is one).
  const minD = Number.isFinite(issue.minDurationSec) && !String(issue.message).includes(String(issue.minDurationSec))
    ? ` (minimum feasible duration ${issue.minDurationSec} s${issue.minDurationVerified === null ? ", an estimate" : ""})`
    : "";
  // durationHelps false: say so unless the page's message already does ("does not slow" / "will not help").
  const noHelp = issue.durationHelps === false && !/longer duration (does not|will not)/.test(String(issue.message))
    ? " (a longer duration will not help)"
    : "";
  return `shot ${shotId}: ${stages} issue ${issue.code}${when}: ${issue.message}${minD}${noHelp}`;
}

/**
 * The facts keepOrRetake (lib/jev_tasks.mjs takeReportWords) reads, from a CLI take report: drained frames vs the
 * planned take frames (dropped), safety adjustments, subject visibility, pop-in, reveal — plus, when the page
 * reported any, `issues` (the take report's page issues and those in its `page` block: validation / overspeed with
 * `minDurationSec`) and `flight`, for the verdict's context (they are plan problems a retake cannot fix, so the
 * keep/retake words do not change).
 * @param {object} report
 * @returns {object}
 */
export function judgeInput(report) {
  const page = report?.page ?? {};
  const obstruction = page.obstruction ?? {};
  const expected = Number(report?.expectedFrames);
  const frames = Number(report?.frames) || 0;
  const dropped = Number.isFinite(Number(page.droppedFrames))
    ? Number(page.droppedFrames)
    : Number.isFinite(expected) && expected > frames ? expected - frames : 0;
  const out = {
    frames,
    droppedFrames: dropped,
    safetyAdjustedFrames: page.safety?.adjustedFrames ?? page.safetyAdjustedFrames ?? 0,
    popInEvents: page.popInEvents ?? page.popIn ?? 0,
    technique: report?.technique ?? null,
    hasSubject: report?.hasSubject !== false,
    reveal: page.reveal === true,
  };
  const minVis = page.subjectMinVisibleFrac ?? obstruction.minVisibleFrac ?? page.subject?.minVisibleFrac;
  if (Number.isFinite(Number(minVis))) out.subjectMinVisibleFrac = Number(minVis);
  const unseen = page.subjectMaxUnseenSec ?? obstruction.maxUnseenSec ?? page.subject?.maxUnseenSec;
  if (Number.isFinite(Number(unseen))) out.subjectMaxUnseenSec = Number(unseen);
  const issues = mergeIssues(mergeIssues([], Array.isArray(report?.issues) ? report.issues : []), pageIssuesOf(page, "shoot"));
  if (issues.length) out.issues = issues;
  const flight = isObj(report?.flight) ? { ...report.flight } : flightOf(page);
  if (flight) out.flight = flight;
  return out;
}

const BAND_RANK = { act: 0, confirm: 1, escalate: 2 };

/**
 * The attempt to keep: the first with keep && band 'act'; else the best by (keep, band, pKeep, earliest).
 * @param {Array<{attempt: number, verdict: object}>} attempts
 * @returns {object}
 */
export function chooseAttempt(attempts) {
  const act = attempts.find((a) => a.verdict?.keep === true && a.verdict?.band === "act");
  if (act) return act;
  return attempts.slice().sort((a, b) => {
    const ka = a.verdict?.keep ? 0 : 1;
    const kb = b.verdict?.keep ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const ba = BAND_RANK[a.verdict?.band] ?? 3;
    const bb = BAND_RANK[b.verdict?.band] ?? 3;
    if (ba !== bb) return ba - bb;
    const pa = Number(a.verdict?.pKeep) || 0;
    const pb = Number(b.verdict?.pKeep) || 0;
    if (pa !== pb) return pb - pa;
    return a.attempt - b.attempt;
  })[0];
}

function errText(err) {
  if (err === undefined || err === null) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Make sure no page operation is running before the CLI's next step (a teleport, the next prepare): read
 * `__film.status()` and, while it reports a running take (`active`, `busy`, `take.running`), call `__film.abort()`
 * and poll until the page is idle or `timeoutMs` passes. The abort is RE-SENT on every poll that still finds the
 * page busy (at most `maxAborts` calls, never after `timeoutMs`): the page's abort only stops a take whose run has
 * started, so one that lands while index.js has busy='shoot' but the take player is still in ready() / clean-frame
 * setup is a no-op (`wasRunning:false`) and the take would then record to its end. Re-aborting a run that already
 * stops is harmless. Never throws: a page without the film API answers `{ok:false, code:'NO_FILM'|'NO_METHOD'}`,
 * an unreadable status counts as not idle.
 * @param {object} page Playwright page
 * @param {{abortFirst?: boolean, timeoutMs?: number, pollMs?: number, maxAborts?: number, now?: () => number,
 *   sleep?: (ms: number) => Promise<void>}} [o] `abortFirst`: abort before the first status read (after a failed
 *   take, when the page state is unknown); `maxAborts` (default PAGE_ABORT_MAX)
 * @returns {Promise<{ok: boolean, aborted: boolean, aborts: number, waitedMs: number, polls: number,
 *   busy: string|null, running: boolean|null, error?: string, code?: string}>} `aborts`: abort calls sent
 */
export async function settlePage(page, o = {}) {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : PAGE_IDLE_WAIT_MS;
  const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : 1000;
  const maxAborts = Number.isInteger(o.maxAborts) && o.maxAborts >= 1 ? o.maxAborts : PAGE_ABORT_MAX;
  const t0 = now();
  let aborts = 0;
  let polls = 0;
  const abort = async () => {
    aborts++;
    try {
      await filmCallWith(page, { soft: true, timeoutMs: 30_000 }, "abort");
    } catch {
      // the status poll decides
    }
  };
  const result = (ok, extra) => ({ ok, aborted: aborts > 0, aborts, waitedMs: now() - t0, polls, ...extra });
  if (o.abortFirst) await abort();
  for (;;) {
    let st;
    try {
      st = await filmCallWith(page, { soft: true, timeoutMs: 15_000 }, "status");
    } catch (e) {
      st = { ok: false, error: e?.message ?? String(e), code: e?.code ?? "STATUS_FAILED" };
    }
    polls++;
    let last;
    if (st && typeof st === "object" && st.ok !== false) {
      const running = st.active === true || (st.busy !== undefined && st.busy !== null) ||
        (st.take?.running !== undefined && st.take?.running !== null && st.take?.running !== false);
      if (!running) return result(true, { busy: null, running: false });
      last = { busy: st.busy ?? null, running: true };
      // The first abort always goes out; later ones while the page is still busy, bounded by count and time.
      if (aborts === 0 || (aborts < maxAborts && now() - t0 < timeoutMs)) await abort();
    } else {
      last = { busy: null, running: null, error: errText(st?.error) || "status unavailable", code: st?.code ?? "STATUS_FAILED" };
      if (st?.code === "NO_FILM" || st?.code === "NO_METHOD") return result(false, last);
    }
    if (now() - t0 >= timeoutMs) return result(false, last);
    await sleep(pollMs);
  }
}

// Attach facts to an error: a settlePage result (`pageIdle`) and/or the attempt's page issues (`pageIssues`).
// FilmCliError → its details; another object → own properties; anything else (or frozen) → wrapped.
function withDetails(e, extra) {
  if (e instanceof FilmCliError) {
    const d = e.details;
    e.details = { ...(d && typeof d === "object" && !Array.isArray(d) ? d : d !== undefined ? { detail: d } : {}), ...extra };
    return e;
  }
  if (e && typeof e === "object") {
    try {
      Object.assign(e, extra);
      return e;
    } catch {
      // frozen: wrap it
    }
  }
  return new FilmCliError(errText(e) || "take failed", { exitCode: EXIT.FINDING, code: "TAKE_FAILED", details: { ...extra }, cause: e });
}

function pageIdleOf(e) {
  return e?.details?.pageIdle ?? e?.pageIdle ?? null;
}

function pageIssuesOfError(e) {
  const list = e?.details?.pageIssues ?? e?.pageIssues;
  return Array.isArray(list) ? list : [];
}

const copyIssues = (list) => list.map((i) => ({ ...i, stages: Array.isArray(i.stages) ? i.stages.slice() : [] }));

function stuckMessage(idle) {
  const secs = Math.round((idle?.waitedMs ?? 0) / 1000);
  const what = idle?.error ? `status unreadable: ${idle.error}` : `still busy${idle?.busy ? ` (${idle.busy})` : ""}`;
  return `the page did not go idle within ${secs} s${idle?.aborted ? " after __film.abort()" : ""} (${what}) — not teleporting or starting a take while one may still be recording`;
}

function missingText(missing) {
  if (!missing || typeof missing !== "object") return "";
  return Object.entries(missing)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${k}: ${v.join(",")}`)
    .join("; ");
}

/**
 * world.prewarm is an optimisation (the readiness gate already passed): an incomplete or failed prewarm warns,
 * logs a `stage:'prewarm'` row and returns a note for the site's take reports; only NO_FILM / NO_METHOD throw.
 * @returns {Promise<object|null>} the note, or null when the prewarm completed
 */
async function prewarmSite(page, entry, { io, log, paths, now }) {
  let pw;
  try {
    pw = await filmCallWith(page, { soft: true, timeoutMs: 300_000 }, "world.prewarm", entry.prewarm);
  } catch (e) {
    if (e instanceof FilmCliError && e.exitCode === EXIT.USAGE) throw e;
    pw = { ok: false, error: e?.message ?? String(e), code: e?.code ?? null };
  }
  if (!pw || typeof pw !== "object" || pw.ok !== false) return null;
  if (pw.code === "NO_FILM" || pw.code === "NO_METHOD") {
    throw new FilmCliError(`__film.world.prewarm failed: ${errText(pw.error)}`, { exitCode: EXIT.USAGE, code: pw.code });
  }
  const miss = missingText(pw.missing);
  const why = pw.timedOut === true ? `timed out${Number.isFinite(pw.waitedMs) ? ` after ${pw.waitedMs} ms` : ""}` : errText(pw.error) || pw.code || "failed";
  io.warn(`site ${entry.siteId}: prewarm incomplete (${why})${miss ? ` — missing ${miss}` : ""}; shooting anyway (pop-in possible)`);
  const note = {
    ok: false,
    timedOut: pw.timedOut === true,
    missing: pw.missing ?? null,
    waitedMs: Number.isFinite(pw.waitedMs) ? pw.waitedMs : null,
    error: pw.error !== undefined && pw.error !== null ? errText(pw.error) : null,
  };
  log(paths.shootLog, { t: new Date(now()).toISOString(), siteId: entry.siteId, stage: "prewarm", ...note });
  return note;
}

/**
 * Send a schedule entry's `prime` commands before its site teleport (see the header): each through goAndWait with
 * its own readiness targets; a throw (other than a usage error) or a not-ready gate only warns. Returns the site's
 * report note, or null when the entry has no prime.
 * @returns {Promise<{sent: number, ready: number, failed: {i: number, cmd: string, error: string}[]}|null>}
 */
async function primeSite(page, entry, { io, log, paths, now, sleep }) {
  const cmds = Array.isArray(entry.prime) ? entry.prime.filter((c) => typeof c === "string" && c.trim()) : [];
  if (!cmds.length) return null;
  const note = { sent: 0, ready: 0, failed: [] };
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i].trim();
    io.info(`   prime ${i + 1}/${cmds.length}: ${cmd}`);
    let go = null;
    let error = null;
    try {
      note.sent++;
      go = await goAndWait(page, {
        teleport: cmd,
        ready: { ...(entry.ready ?? {}), ...readyTargetsForCommand(cmd) },
        timeoutSec: entry.ready?.timeoutSec ?? 90,
        now,
        sleep,
        log: (m) => io.info(`   ${m}`),
      });
    } catch (e) {
      if (e instanceof FilmCliError && e.exitCode === EXIT.USAGE) throw e;
      error = e?.message ?? String(e);
    }
    const ok = go?.ok === true;
    if (ok) {
      note.ready++;
      io.info(`   prime ${i + 1} ready in ${(go.elapsedMs / 1000).toFixed(1)} s`);
    } else {
      const why = error ? `failed: ${error}` : `not ready after ${Math.round((go?.elapsedMs ?? 0) / 1000)} s`;
      io.warn(`site ${entry.siteId}: prime ${i + 1}/${cmds.length} (${cmd}) ${why} — going on (creatures near it may be missing)`);
      note.failed.push({ i, cmd, error: error ?? why });
    }
    log(paths.shootLog, {
      t: new Date(now()).toISOString(), event: "prime", siteId: entry.siteId, i, of: cmds.length, cmd, ok,
      ...(go ? { elapsedMs: go.elapsedMs } : {}),
      ...(error ? { error } : !ok ? { error: `not ready after ${Math.round((go?.elapsedMs ?? 0) / 1000)} s` } : {}),
    });
  }
  return note;
}

/** A shot whose camera path is more than this far (m, horizontal) from the hidden player moves the player first. */
export const STAND_HOP_M = 40;
/** A hop lands this far (m) above the ground height the page reports (the server drops the player onto it). */
export const HOP_LIFT_M = 0.5;
/** Camera samples per shot for its stand point. */
const STAND_SAMPLES = 13;

const isXyz = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite);

/**
 * Where the hidden player should stand for a shot: the horizontal centroid of its camera path, built offline
 * like `plan validate --dry` (scene3d/film/shots buildShot, ground unknown — only the horizontal path is used),
 * else the point subject's position. null when the position cannot be known offline (an entity / player
 * subject) or there is nothing to build.
 * @param {object} item timeline item (`item.take`: spec, subject, path, anchor, capture)
 * @param {Function|null} buildShot scene3d/film/shots/index.js buildShot
 * @returns {{pos: number[], spanM: number, source: 'camera'|'subject'}|null}
 */
export function standPointOf(item, buildShot) {
  const take = item && typeof item === "object" ? item.take : null;
  if (!take || typeof take !== "object") return null;
  const s = take.subject;
  const point = s && typeof s === "object" && !Array.isArray(s) && (s.kind ?? "point") === "point" && isXyz(s.pos) ? s
    : Array.isArray(s) && isXyz(s) ? { pos: s } : null;
  const pathPts = Array.isArray(take.path) ? take.path : s && s.kind === "path" && Array.isArray(s.points) ? s.points : undefined;
  if (!point && !pathPts) return null;
  const pts = [];
  if (typeof buildShot === "function" && take.spec && typeof take.spec === "object") {
    try {
      const cap = take.capture ?? {};
      const subject = point ? {
        pos: point.pos.slice(0, 3),
        radius: Number.isFinite(point.radius) ? point.radius : 0.6,
        height: Number.isFinite(point.height) ? point.height : 1.8,
        ...(Number.isFinite(point.heading) ? { heading: point.heading } : {}),
      } : null;
      const traj = buildShot(take.spec, {
        subject,
        anchor: isXyz(take.anchor) ? take.anchor : point ? point.pos : pathPts[0],
        groundZ: () => null,
        path: pathPts,
        ...(Number.isFinite(cap.width) && Number.isFinite(cap.height) && cap.height > 0 ? { aspect: cap.width / cap.height } : {}),
        ...(Number.isFinite(cap.fps) ? { fps: cap.fps } : {}),
      });
      const D = traj && Number.isFinite(traj.duration) ? Math.max(0, traj.duration) : 0;
      for (let i = 0; i < STAND_SAMPLES; i++) {
        const pose = traj.sample((D * i) / (STAND_SAMPLES - 1));
        if (pose && isXyz(pose.pos)) pts.push(pose.pos);
      }
    } catch {
      pts.length = 0;
    }
  }
  if (!pts.length) return point ? { pos: [point.pos[0], point.pos[1]], spanM: 0, source: "subject" } : null;
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const spanM = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
  return { pos: [cx, cy], spanM, source: "camera" };
}

/** The hidden player's position (AC world metres) from the page, or null. */
async function playerPosOf(page) {
  try {
    const r = await filmCallWith(page, { soft: true, timeoutMs: 15_000 }, "query.subject", "player");
    return r && r.ok === true && r.subject && isXyz(r.subject.pos) ? r.subject.pos.slice(0, 3) : null;
  } catch {
    return null;
  }
}

/**
 * Move the hidden player next to a shot's camera path when it is more than `hopM` away (see the header).
 * @returns {Promise<{hopped: boolean, playerPos: number[]|null, note?: object, stuck?: string}>}
 */
async function hopForShot(o) {
  const { page, entry, item, hopM, io, log, paths, now, sleep } = o;
  const take = item.take ?? {};
  const actor = Array.isArray(take.actor) ? take.actor.length > 0 : take.actor !== undefined && take.actor !== null;
  if (entry.indoor === true || take.indoor === true || (take.cell !== undefined && take.cell !== null) || take.showAvatar === true || actor) {
    return { hopped: false, playerPos: o.playerPos };
  }
  const stand = standPointOf(item, o.buildShot);
  if (!stand) return { hopped: false, playerPos: o.playerPos };
  const from = o.playerPos ?? (await playerPosOf(page));
  if (!from) {
    io.warn(`   ${item.shotId}: the hidden player's position is unknown — not moving it`);
    return { hopped: false, playerPos: null };
  }
  const distM = Math.hypot(stand.pos[0] - from[0], stand.pos[1] - from[1]);
  if (distM <= hopM) return { hopped: false, playerPos: from };
  let ground = null;
  try {
    ground = await filmCallWith(page, { soft: true, timeoutMs: 15_000 }, "query.groundZ", [stand.pos[0], stand.pos[1]]);
  } catch {
    ground = null;
  }
  if (!ground || ground.ok !== true || !Number.isFinite(ground.z)) {
    io.warn(`   ${item.shotId}: no ground height at its camera path yet — not moving the player (${Math.round(distM)} m away)`);
    return { hopped: false, playerPos: from };
  }
  const loc = localFromWorld(stand.pos[0], stand.pos[1], ground.z + HOP_LIFT_M);
  const cmd = telelocCmd(loc.cellId, loc.lx, loc.ly, loc.z);
  const idle = await settlePage(page, o.idleOpts);
  if (!idle.ok) {
    if (idle.code === "NO_FILM" || idle.code === "NO_METHOD") {
      throw new FilmCliError(`__film.status failed: ${idle.error}`, { exitCode: EXIT.USAGE, code: idle.code });
    }
    return { hopped: false, playerPos: from, stuck: stuckMessage(idle) };
  }
  io.info(`   ${item.shotId}: the player is ${Math.round(distM)} m from the shot's camera path — hop: ${cmd}`);
  let go = null;
  let error = null;
  try {
    go = await goAndWait(page, {
      teleport: cmd,
      ready: { ...(entry.ready ?? {}), ...readyTargetsForCommand(cmd) },
      timeoutSec: entry.ready?.timeoutSec ?? 90,
      now,
      sleep,
      log: (m) => io.info(`   ${m}`),
    });
  } catch (e) {
    if (e instanceof FilmCliError && e.exitCode === EXIT.USAGE) throw e;
    error = e?.message ?? String(e);
  }
  const ok = go?.ok === true;
  if (ok) io.info(`   ready in ${(go.elapsedMs / 1000).toFixed(1)} s`);
  else io.warn(`   hop for ${item.shotId} ${error ? `failed: ${error}` : `not ready after ${Math.round((go?.elapsedMs ?? 0) / 1000)} s`} — shooting from where the player is`);
  const note = {
    from: from.map((v) => Math.round(v * 10) / 10),
    to: [stand.pos[0], stand.pos[1], loc.z].map((v) => Math.round(v * 10) / 10),
    distM: Math.round(distM),
    cmd,
    ok,
    ...(go ? { elapsedMs: go.elapsedMs } : {}),
    ...(error ? { error } : {}),
  };
  log(paths.shootLog, { t: new Date(now()).toISOString(), event: "hop", shotId: item.shotId, siteId: entry.siteId, ...note });
  const after = await playerPosOf(page);
  return { hopped: true, playerPos: after, note };
}

/**
 * Shoot the selected part of a timeline on a booted film page.
 * @param {object} o
 * @param {object} o.page Playwright page (booted: `film boot`)
 * @param {object} o.timeline compiled Timeline
 * @param {Array<{entry: object, shots: string[]}>} o.selection from selectSchedule
 * @param {{takes: string, reports: string, shootLog: string}} o.paths project paths
 * @param {'avc'|'vp9'|'frames'} [o.codec='avc'] requested encoder (the page may fall back; the sink follows)
 * @param {number} [o.bitrate=40000000]
 * @param {number} [o.retakes=1]
 * @param {'auto'|'always'|'never'} [o.rehearse='auto']
 * @param {number} [o.rehearseFps=8]
 * @param {boolean} [o.locked=false] replay the rehearsal's realised table (no pilot)
 * @param {'mp4'|'webm'} [o.vp9Container='mp4']
 * @param {{decide: Function}|null} [o.jev] JEV client for keepOrRetake (null → code verdict)
 * @param {{setDecideOptions: Function, dumpTelemetry: Function, telemetryMark?: Function}|null} [o.broker]
 * @param {Function} o.keepOrRetake lib/jev_tasks.mjs keepOrRetake
 * @param {string} o.ffmpeg
 * @param {Function} [o.spawn]
 * @param {boolean} [o.capped]
 * @param {typeof nodeFs} [o.fs]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {{info: Function, warn: Function, scrub: Function}} o.io
 * @param {number} [o.drainPollMs=200]
 * @param {number} [o.idleWaitMs=PAGE_IDLE_WAIT_MS] how long settlePage waits for an idle page
 * @param {number} [o.idlePollMs=1000]
 * @param {number} [o.hopM=STAND_HOP_M] in-site hop distance (0 = never move the player inside a site)
 * @param {Function|null} [o.buildShot] scene3d/film/shots buildShot (standPointOf); null = no hops
 * @returns {Promise<{ok: boolean, teleports: number, hops: number, primes: number, shots: object[], failures: object[]}>}
 *   `teleports`: site teleports; `primes`: site.prime commands sent before them; failures:
 *   `{shotId, siteId, stage: 'busy'|'site'|'ready'|'plan'|'take'|'verdict', message, issues?}`; shots[]:
 *   `{shotId, siteId, file, frames, kept, verdict, attempts, issues, failedAttempts?, pageIdle?}` (`issues`: the
 *   kept attempt's page issues, see pageIssuesOf)
 */
export async function shootSchedule(o) {
  const fs = o.fs ?? nodeFs;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const io = o.io;
  const { page, timeline, selection, paths } = o;
  const codec = o.codec ?? "avc";
  const retakes = Number.isInteger(o.retakes) ? o.retakes : 1;
  const results = [];
  const failures = [];
  let teleports = 0;
  let hops = 0;
  let primes = 0;
  const hopM = Number.isFinite(o.hopM) && o.hopM >= 0 ? o.hopM : STAND_HOP_M;
  const buildShot = typeof o.buildShot === "function" ? o.buildShot : null;
  let playerPos = null;
  const items = new Map((timeline.items ?? []).map((it) => [it.shotId, it]));
  const wj = (file, obj) => writeJsonFile(file, obj, { fs, scrub: io.scrub, replacer: jsonReplacer });
  const log = (file, obj) => appendJsonl(file, obj, { fs, scrub: io.scrub, replacer: jsonReplacer });

  const idleOpts = { now, sleep, timeoutMs: o.idleWaitMs, pollMs: o.idlePollMs };
  // Set once the page would not go idle (a take may still be recording): nothing else is sent to it — no
  // teleport, no prepare — and every remaining shot fails at stage 'busy'.
  let stuck = null;
  const failSite = (entry, shots, stage, message) => {
    for (const s of shots) failures.push({ shotId: s, siteId: entry.siteId, stage, message });
    log(paths.shootLog, { t: new Date(now()).toISOString(), siteId: entry.siteId, shots, stage, ok: false, error: message });
  };

  for (const { entry, shots } of selection) {
    if (stuck) {
      failSite(entry, shots, "busy", stuck);
      continue;
    }
    io.info(`── site ${entry.siteId}: ${entry.teleport}`);
    // Never teleport while a take runs: a leftover take (an earlier failure, another process) is aborted first.
    const idle = await settlePage(page, idleOpts);
    if (!idle.ok) {
      if (idle.code === "NO_FILM" || idle.code === "NO_METHOD") {
        throw new FilmCliError(`__film.status failed: ${idle.error}`, { exitCode: EXIT.USAGE, code: idle.code });
      }
      stuck = stuckMessage(idle);
      io.warn(`${stuck} — skipping site ${entry.siteId} and everything after it`);
      failSite(entry, shots, "busy", stuck);
      continue;
    }
    if (idle.aborted) io.warn(`a take was still running on the page before site ${entry.siteId}: aborted it (idle after ${(idle.waitedMs / 1000).toFixed(1)} s)`);
    // site.prime: walk the hidden player along the route first (only warns), then the site teleport stands it here
    const primeNote = await primeSite(page, entry, { io, log, paths, now, sleep });
    if (primeNote) primes += primeNote.sent;
    let go;
    try {
      teleports++;
      go = await goAndWait(page, {
        teleport: entry.teleport,
        ready: entry.ready ?? {},
        timeoutSec: entry.ready?.timeoutSec ?? 90,
        now,
        sleep,
        log: (m) => io.info(`   ${m}`),
      });
    } catch (e) {
      if (e instanceof FilmCliError && e.exitCode === EXIT.USAGE) throw e;
      const why = `site ${entry.siteId} setup failed: ${e?.message ?? e}`;
      io.warn(`${why} — skipping its shots (${shots.join(", ")})`);
      failSite(entry, shots, "site", why);
      continue;
    }
    if (!go.ok) {
      const why = `site ${entry.siteId} not ready after ${Math.round(go.elapsedMs / 1000)} s: ${JSON.stringify(go.report?.checks ?? go.report ?? {})}`;
      io.warn(`${why} — skipping its shots (${shots.join(", ")})`);
      for (const s of shots) failures.push({ shotId: s, siteId: entry.siteId, stage: "ready", message: why });
      continue;
    }
    io.info(`   ready in ${(go.elapsedMs / 1000).toFixed(1)} s`);
    const prewarmNote = entry.prewarm ? await prewarmSite(page, entry, { io, log, paths, now }) : null;
    playerPos = hopM > 0 && buildShot ? await playerPosOf(page) : null;

    for (const shotId of shots) {
      if (stuck) {
        failures.push({ shotId, siteId: entry.siteId, stage: "busy", message: stuck });
        continue;
      }
      const item = items.get(shotId);
      if (!item) {
        failures.push({ shotId, siteId: entry.siteId, stage: "plan", message: `shot ${shotId} is in the schedule but not in timeline.items` });
        continue;
      }
      let hopNote = null;
      if (hopM > 0 && buildShot) {
        const h = await hopForShot({ page, entry, item, hopM, buildShot, playerPos, idleOpts, io, log, paths, now, sleep });
        playerPos = h.playerPos;
        if (h.stuck) {
          stuck = h.stuck;
          io.warn(`${stuck} — skipping the remaining shots`);
          failures.push({ shotId, siteId: entry.siteId, stage: "busy", message: stuck });
          continue;
        }
        if (h.hopped) {
          hops++;
          hopNote = h.note;
        }
      }
      try {
        const r = await shootOne({ ...o, fs, now, sleep, codec, retakes, entry, item, wj, log, prewarmNote, hopNote, primeNote });
        results.push(r);
        if (!r.kept) {
          const retake = r.failedAttempts?.length ? ` (retake ${r.failedAttempts.map((f) => f.attempt).join(", ")} failed: ${r.failedAttempts.at(-1).message})` : "";
          failures.push({ shotId, siteId: entry.siteId, stage: "verdict", message: `no attempt kept: ${r.verdict?.reasons?.join("; ") || r.verdict?.band}${retake}` });
        }
        if (r.pageIdle && r.pageIdle.ok === false) {
          stuck = stuckMessage(r.pageIdle);
          io.warn(`${stuck} — skipping the remaining shots`);
        }
      } catch (e) {
        if (e instanceof FilmCliError && e.exitCode === EXIT.USAGE) throw e;
        const message = e?.message ?? String(e);
        io.warn(`shot ${shotId} failed: ${message}`);
        // The page issues seen before the failure (an overspeed found at prepare often explains a bad take).
        const issues = pageIssuesOfError(e);
        failures.push({ shotId, siteId: entry.siteId, stage: "take", message, ...(issues.length ? { issues } : {}) });
        const pi = pageIdleOf(e);
        log(paths.shootLog, { t: new Date(now()).toISOString(), shotId, siteId: entry.siteId, ok: false, error: message, issues, ...(pi ? { pageIdle: pi } : {}) });
        if (pi && pi.ok === false) {
          stuck = stuckMessage(pi);
          io.warn(`${stuck} — skipping the remaining shots`);
        }
      }
    }
  }
  return { ok: failures.length === 0, teleports, hops, primes, shots: results, failures };
}

async function shootOne(o) {
  const { page, timeline, paths, io, fs, now, item, entry, wj, log } = o;
  const shotId = item.shotId;
  const fps = timeline.fps;
  const take = item.take ?? {};
  const mode = item.captureMode === "realtime" ? "realtime" : "stepped";
  const preRollFrames = Math.ceil((Number(item.preRollSec) || 0) * fps);
  const plannedFrames = Number.isInteger(item.takeFrames) ? item.takeFrames : Math.round((Number(item.takeDuration) || 0) * fps);
  const evalBudgetMs = (plannedFrames + preRollFrames) * 500 + 300_000;
  let rehearsal = null;
  const attempts = [];
  const failedAttempts = [];
  let pageIdle = null;
  // One broker serves the whole schedule: this shot's telemetry file holds only what is recorded from here on.
  const jevMark = typeof o.broker?.telemetryMark === "function" ? o.broker.telemetryMark() : null;
  // Page issues (validation, flight check / overspeed, warnings): the shot's first prepare summary (never a locked
  // table replay, so its flight check is the real one), the rehearsal's issues (carried into every attempt), the
  // flight block, and the issues already printed (each one warns once per shot, not once per stage or attempt; a
  // `tracking-gap` is keyed by its message and t, so each run whose realised gap differs is its own issue).
  let firstPrep = null;
  let rehearsalIssues = [];
  let shotFlight = null;
  const warned = [];
  const surface = (found) => {
    for (const i of found) {
      if (warned.some((w) => sameIssue(w, i))) continue;
      warned.push(i);
      io.warn(issueLine(shotId, i));
    }
  };

  // One attempt: prepare → [rehearse] → shoot + drain → mux → report → verdict. Throws on failure; a failure in the
  // page part (prepare … drain) first aborts the page take and waits for an idle page (details.pageIdle); every
  // failure carries the page issues seen so far (details.pageIssues).
  const recordAttempt = async (attempt) => {
    const issues = copyIssues(rehearsalIssues);
    try {
      return await recordAttemptIn(attempt, issues);
    } catch (e) {
      throw withDetails(e, { pageIssues: copyIssues(issues) });
    }
  };
  const recordAttemptIn = async (attempt, issues) => {
    const stem = takeStem(shotId, attempt);
    const startedAt = new Date(now()).toISOString();
    const t0 = now();
    // Record what a page result reports (never throws on it): issues, warnings, the flight block.
    const note = (res, stage) => {
      const found = pageIssuesOf(res, stage);
      mergeIssues(issues, found);
      surface(found);
      shotFlight ??= flightOf(res);
      return res;
    };
    const prepare = async (t) => {
      const prep = note(await filmCallWith(page, { timeoutMs: 120_000 }, "prepare", t), "prepare");
      if (firstPrep === null && isObj(prep)) firstPrep = prep;
      return prep;
    };
    io.info(`   shot ${shotId}${attempt ? ` (retake ${attempt})` : ""}: ${item.technique} ${item.takeDuration}s ${mode}`);
    if (take.showAvatar) await filmCall(page, "world.avatar", true);
    let drained;
    let raw;
    let pageEnv = null;
    try {
      try {
        const prepTake = o.locked && rehearsal?.table ? { ...take, table: rehearsal.table } : take;
        await prepare(prepTake);
        if (attempt === 0 && needsRehearsal(item, entry, o.rehearse ?? "auto")) {
          io.info(`   rehearsing ${shotId} at ${o.rehearseFps ?? 8} fps`);
          // A rehearsal is always stepped (the page waits 15 s per decision): never the previous take's limits.
          o.broker?.setDecideOptions?.(DECIDE_OPTIONS.stepped);
          const res = note(await filmCallWith(page, { timeoutMs: evalBudgetMs }, "rehearse", { fps: o.rehearseFps ?? 8 }), "rehearse");
          rehearsalIssues = copyIssues(issues);
          rehearsal = saveRehearsal(res, { shotId, paths, fs, io, wj, issues: rehearsalIssues, flight: flightOf(res, firstPrep) });
          if (o.locked && rehearsal.table) await prepare({ ...take, table: rehearsal.table });
          else await prepare(take);
        }
        o.broker?.setDecideOptions?.(DECIDE_OPTIONS[mode]);
        // what the take is recorded with (read-only; null when the page cannot say — never fails the take)
        pageEnv = await pageEnvOf(page);
        const sink = createTakeSink({ dir: paths.takes, name: stem, codec: "auto", fps, width: timeline.width, height: timeline.height, fs });
        const shootOpts = { fps, width: timeline.width, height: timeline.height, codec: o.codec, bitrate: o.bitrate ?? 40_000_000, mode, locked: Boolean(o.locked && rehearsal?.table) };
        const shootPromise = filmCallWith(page, { timeoutMs: evalBudgetMs }, "shoot", shootOpts);
        try {
          drained = await drainTake({
            drain: (d) => filmCallWith(page, { timeoutMs: 60_000 }, "recorder.drain", d),
            sink,
            shootPromise,
            maxBytes: DRAIN_MAX_BYTES,
            pollMs: o.drainPollMs ?? 200,
            sleep: o.sleep,
            now,
          });
        } finally {
          raw = sink.close();
        }
      } catch (e) {
        if (e instanceof FilmCliError && e.exitCode === EXIT.USAGE) throw e;
        // The page may still be running the take (a drain or disk error, an evaluate timeout): stop it and wait
        // for an idle page before anything else talks to it.
        const idle = await settlePage(page, { abortFirst: true, now, sleep: o.sleep, timeoutMs: o.idleWaitMs, pollMs: o.idlePollMs });
        io.warn(`take ${stem} failed (${e?.message ?? e}); ${idle.ok ? `the page is idle again (${(idle.waitedMs / 1000).toFixed(1)} s after __film.abort())` : "the page did NOT go idle after __film.abort()"}`);
        throw withDetails(e, { pageIdle: idle });
      }
    } finally {
      if (take.showAvatar) {
        try {
          await filmCall(page, "world.avatar", false);
        } catch (e) {
          io.warn(`could not hide the avatar again: ${e?.message ?? e}`);
        }
      }
    }
    if (!raw.kind || raw.frames === 0) {
      throw new FilmCliError(`take ${stem} recorded no frames`, { exitCode: EXIT.FINDING, code: "EMPTY_TAKE" });
    }
    if (raw.kind !== o.codec) io.warn(`take ${stem}: requested ${o.codec} but the recorder produced ${raw.kind} (encoder fallback)`);
    const ext = raw.kind === "vp9" && o.vp9Container === "webm" ? "webm" : "mp4";
    const file = path.join(paths.takes, `${stem}.${ext}`);
    await runFfmpeg(o.ffmpeg, muxArgv({ kind: raw.kind, input: raw.path, output: file, fps, container: ext }), { spawn: o.spawn, capped: o.capped, what: `ffmpeg mux ${stem}` });
    let bytes = null;
    try {
      bytes = fs.statSync(file).size;
    } catch {
      throw new FilmCliError(`ffmpeg reported success but ${file} is missing`, { exitCode: EXIT.FINDING, code: "MUX_MISSING" });
    }
    const pageReport = note(drained?.shootResult && typeof drained.shootResult === "object" ? drained.shootResult : {}, "shoot");
    if (raw.frames !== plannedFrames) io.warn(`take ${stem}: drained ${raw.frames} frames, planned ${plannedFrames}`);
    const report = {
      shotId,
      siteId: item.siteId,
      technique: item.technique,
      family: item.family,
      attempt,
      file,
      fps,
      frames: raw.frames,
      durationSec: raw.frames / fps,
      expectedFrames: plannedFrames,
      bytes,
      raw: { kind: raw.kind, requested: o.codec, path: raw.path, bytes: raw.bytes, keyFrames: raw.keyFrames, seqGaps: raw.seqGaps, duplicates: raw.duplicates, firstTimestampUs: raw.firstTimestampUs, lastTimestampUs: raw.lastTimestampUs },
      drain: { polls: drained?.polls ?? 0, chunks: drained?.chunks ?? 0, stats: drained?.lastStats ?? null },
      take: { takeDuration: item.takeDuration, takeFrames: item.takeFrames, preRollSec: item.preRollSec, editOffsetSec: take.editOffsetSec ?? item.handleIn ?? 0, captureMode: mode, showAvatar: Boolean(take.showAvatar) },
      hasSubject: take.subject != null,
      rehearsed: Boolean(rehearsal),
      locked: Boolean(o.locked && rehearsal?.table),
      page: pageReport,
      // The page's own findings about the plan (prepare / rehearse / shoot): never a failure, see pageIssuesOf.
      issues: copyIssues(issues),
      validation: validationSummary(firstPrep),
      flight: shotFlight,
      pageEnv,
      ...(o.prewarmNote ? { prewarm: o.prewarmNote } : {}),
      ...(o.primeNote ? { prime: o.primeNote } : {}),
      ...(o.hopNote ? { hop: o.hopNote } : {}),
      startedAt,
      ms: now() - t0,
    };
    const verdict = await judge(o, report);
    return { attempt, stem, file, report, verdict };
  };

  try {
    for (let attempt = 0; attempt <= o.retakes; attempt++) {
      let rec;
      try {
        rec = await recordAttempt(attempt);
      } catch (e) {
        // The first attempt failing fails the shot (shootSchedule records it); a usage error stops the run.
        if (attempts.length === 0 || (e instanceof FilmCliError && e.exitCode === EXIT.USAGE)) throw e;
        // A failed RETAKE keeps what is already recorded: its partial raw file stays, it is never chosen or renamed.
        const message = e?.message ?? String(e);
        const pi = pageIdleOf(e);
        if (pi) pageIdle = pi;
        const issues = pageIssuesOfError(e);
        failedAttempts.push({ attempt, stem: takeStem(shotId, attempt), message, code: e?.code ?? null, ...(pi ? { pageIdle: pi } : {}) });
        io.warn(`retake ${attempt} of ${shotId} failed (${message}); keeping the ${attempts.length} attempt(s) already recorded`);
        log(paths.shootLog, { t: new Date(now()).toISOString(), shotId, siteId: item.siteId, attempt, ok: false, error: message, code: e?.code ?? null, issues, ...(pi ? { pageIdle: pi } : {}) });
        break;
      }
      const { verdict, file } = rec;
      attempts.push(rec);
      log(paths.shootLog, { t: new Date(now()).toISOString(), shotId, siteId: item.siteId, attempt, file, frames: rec.report.frames, keep: verdict.keep, band: verdict.band, source: verdict.source, reasons: verdict.reasons, issues: rec.report.issues });
      const nIssues = rec.report.issues.length;
      io.info(`   ${rec.stem}: ${rec.report.frames} frames → ${path.basename(file)} · ${verdict.keep ? "keep" : "retake"} (${verdict.band}, ${verdict.source})${verdict.reasons?.length ? ` — ${verdict.reasons.join("; ")}` : ""}${nIssues ? ` · ${nIssues} page issue(s): ${rec.report.issues.map((i) => i.code).join(", ")}` : ""}`);
      if (verdict.keep === true && verdict.band === "act") break;
      if (attempt < o.retakes) io.info(`   retaking ${shotId}: band ${verdict.band}${verdict.keep ? "" : ", verdict retake"}`);
    }
  } finally {
    if (o.broker?.dumpTelemetry) {
      try {
        o.broker.dumpTelemetry(path.join(paths.reports, `${shotId}.jev.jsonl`), { since: jevMark });
      } catch (e) {
        io.warn(`JEV telemetry dump failed: ${e?.message ?? e}`);
      }
    }
  }

  const chosen = chooseAttempt(attempts);
  if (chosen.attempt !== 0) keepRetake(fs, paths.takes, shotId, attempts[0], chosen);
  const finalReport = {
    ...chosen.report,
    file: chosen.file,
    keptAttempt: chosen.attempt,
    verdict: chosen.verdict,
    attempts: attempts.map((a) => ({ attempt: a.attempt, file: a.file, frames: a.report.frames, keep: a.verdict.keep, band: a.verdict.band, source: a.verdict.source, reasons: a.verdict.reasons })),
    ...(failedAttempts.length ? { failedAttempts: failedAttempts.map((f) => ({ attempt: f.attempt, message: f.message, code: f.code })) } : {}),
  };
  wj(path.join(paths.reports, `${shotId}.json`), finalReport);
  return {
    shotId,
    siteId: item.siteId,
    file: finalReport.file,
    frames: finalReport.frames,
    kept: chosen.verdict.keep === true,
    verdict: chosen.verdict,
    attempts: attempts.length,
    issues: finalReport.issues,
    ...(failedAttempts.length ? { failedAttempts: finalReport.failedAttempts } : {}),
    ...(pageIdle ? { pageIdle } : {}),
  };
}

/**
 * A retake was kept: move the first attempt's file to <shot>.retake0.<ext> and the kept one to <shot>.<ext>, so the
 * canonical name always holds the keeper. Updates the attempts' `file` fields.
 */
function keepRetake(fs, takesDir, shotId, first, chosen) {
  const ext0 = path.extname(first.file);
  const extK = path.extname(chosen.file);
  const firstMoved = path.join(takesDir, `${shotId}.retake0${ext0}`);
  const canonical = path.join(takesDir, `${shotId}${extK}`);
  fs.renameSync(first.file, firstMoved);
  fs.renameSync(chosen.file, canonical);
  first.file = firstMoved;
  first.report.file = firstMoved;
  chosen.file = canonical;
  chosen.report.file = canonical;
}

async function judge(o, report) {
  const input = judgeInput(report);
  if (typeof o.keepOrRetake !== "function") return { keep: true, band: "confirm", source: "none", reasons: [] };
  try {
    return await o.keepOrRetake(o.jev ?? null, input);
  } catch (e) {
    // JEV failed (budget, rate, network…): the deterministic code verdict from the same words.
    o.io.warn(`keepOrRetake via JEV failed (${e?.kind ?? e?.name}: ${e?.message ?? e}); using the code verdict`);
    const v = await o.keepOrRetake(null, input);
    return { ...v, jevError: { kind: e?.kind ?? null, message: e?.message ?? String(e) } };
  }
}

// reports/<shot>.rehearsal.json = the page's rehearse result (minus the telemetry, which goes to <shot>.pilot.jsonl)
// + `issues` (the CLI's page issues of the prepare and the rehearsal) + `flight` when the page result has none.
function saveRehearsal(res, { shotId, paths, io, wj, fs, issues = [], flight = null }) {
  const r = res && typeof res === "object" ? res : {};
  const telemetry = Array.isArray(r.pilotTelemetry) ? r.pilotTelemetry : Array.isArray(r.telemetry) ? r.telemetry : Array.isArray(r.pilot?.telemetry) ? r.pilot.telemetry : [];
  const table = r.realisedTable ?? r.table ?? null;
  const { pilotTelemetry, telemetry: _t, ...rest } = r;
  const file = path.join(paths.reports, `${shotId}.rehearsal.json`);
  wj(file, { shotId, ...rest, issues, ...(rest.flight === undefined && flight ? { flight } : {}), telemetryCount: telemetry.length });
  const tl = path.join(paths.reports, `${shotId}.pilot.jsonl`);
  fs.mkdirSync(path.dirname(tl), { recursive: true });
  fs.writeFileSync(tl, telemetry.map((e) => io.scrub(JSON.stringify(e, jsonReplacer))).join("\n") + (telemetry.length ? "\n" : ""), "utf8");
  return { file, telemetryFile: tl, table, telemetryCount: telemetry.length };
}

/**
 * Rehearse one shot on its own (`film rehearse`): prepare → rehearse({fps}) → reports/<shot>.rehearsal.json +
 * reports/<shot>.pilot.jsonl. The page issues of the prepare and the rehearsal (validation, overspeed with
 * minDurationSec, the realised tracking-gap of the flown rehearsal, warnings — see pageIssuesOf) each print one
 * warning and go into the rehearsal file; they never fail the rehearsal.
 * @param {{page: object, item: object, fps: number, paths: object, io: object, fs?: typeof nodeFs}} o
 * @returns {Promise<{file: string, telemetryFile: string, telemetryCount: number, issues: object[],
 *   flight: object|null, result: object}>}
 */
export async function rehearseShot({ page, item, fps, paths, io, fs = nodeFs }) {
  const plannedFrames = Number.isInteger(item.takeFrames) ? item.takeFrames : 0;
  const prep = await filmCallWith(page, { timeoutMs: 120_000 }, "prepare", item.take);
  const res = await filmCallWith(page, { timeoutMs: plannedFrames * 500 + 300_000 }, "rehearse", { fps });
  const issues = mergeIssues(pageIssuesOf(prep, "prepare"), pageIssuesOf(res, "rehearse"));
  for (const i of issues) io.warn(issueLine(item.shotId, i));
  const flight = flightOf(res, prep);
  const wj = (file, obj) => writeJsonFile(file, obj, { fs, scrub: io.scrub, replacer: jsonReplacer });
  const saved = saveRehearsal(res, { shotId: item.shotId, paths, io, wj, fs, issues, flight });
  return { file: saved.file, telemetryFile: saved.telemetryFile, telemetryCount: saved.telemetryCount, issues, flight, result: res };
}
