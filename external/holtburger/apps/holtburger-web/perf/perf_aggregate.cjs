// perf_aggregate.cjs — pure aggregation, ranking, statistical gate, and tour
// slicing for the explorer perf loop. NO browser, NO fs, NO clock: every
// function here is a deterministic transform of its inputs, so the self-test
// covers the load-bearing logic without any infra (and without touching the
// live soak). The driver (perf_loop.cjs) owns all I/O.
//
// The design rule this file encodes: the LLM/prompt decides only WHICH content
// gets sampled (coverage). Whether sampled content is a perf offender, and
// whether a candidate build is actually faster, is decided HERE, deterministically
// — never by the model's self-report. A prompt rewrite changes the sample
// distribution; it can never change a verdict.

// ── sample parsing ──────────────────────────────────────────────────────────

/** Parse a JSONL stream of driver-stamped samples. Each accepted line is an
 *  object with at least {lb, dt:{p95,...}}. Lines that don't parse or lack a
 *  usable frame-time are dropped (and counted). Returns {samples, dropped}. */
function parseSamples(text) {
  var samples = [], dropped = 0;
  var lines = String(text || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (!ln) continue;
    var obj;
    try { obj = JSON.parse(ln); } catch (e) { dropped++; continue; }
    // Keep a sample if it carries EITHER a frame-time OR bake data. Decode-stall
    // windows freeze rAF (frames=0 → no dt) — those are the WORST decode windows
    // and must not be dropped now that the axis is decode/residency, not p95.
    if (!obj || (!(obj.dt && obj.dt.p95 != null) && !obj.bake)) { dropped++; continue; }
    samples.push(obj);
  }
  return { samples: samples, dropped: dropped };
}

// ── percentile / stats helpers ──────────────────────────────────────────────

function sortedNums(arr) {
  return arr.filter(function (v) { return typeof v === "number" && isFinite(v); })
            .sort(function (a, b) { return a - b; });
}
function quantile(sorted, p) {
  if (!sorted.length) return null;
  var i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function median(arr) { return quantile(sortedNums(arr), 50); }
function round(v, d) { if (v == null) return null; var m = Math.pow(10, d || 1); return Math.round(v * m) / m; }

// ── ranking (RANK step) ─────────────────────────────────────────────────────

/** Bin samples by landblock word, score each bin, return the ranked league.
 *  Badness = pooled frame-time p95 (median of per-sample p95s in the bin);
 *  ties broken by worst-case then by dwell (more time spent hurting = worse). */
function rankByLandblock(samples, opts) {
  opts = opts || {};
  var minSamples = opts.minSamples || 2; // a 1-sample bin is a drive-through, not a signal
  var bins = {};
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i], lb = s.lb || "unknown";
    var b = bins[lb] || (bins[lb] = { lb: lb, p95s: [], worsts: [], draws: [], tris: [], heaps: [], bakeds: [], dPosted: [], dDecodeMs: [], wasmMB: [], maxQueueMs: 0, worstDecode: -1, n: 0, dwellSec: 0, worstP95: -1, waypoint: null });
    b.n++;
    if (s.dt) {
      b.p95s.push(s.dt.p95); if (s.dt.worst != null) b.worsts.push(s.dt.worst);
      // Representative waypoint = the pose at this bin's worst frame (fork #1).
      if (s.pos && s.dt.p95 > b.worstP95) { b.worstP95 = s.dt.p95; b.waypoint = s.pos; }
    }
    if (s.draw != null) b.draws.push(s.draw);
    if (s.tri != null) b.tris.push(s.tri);
    if (s.heapMB != null) b.heaps.push(s.heapMB);
    if (s.baked != null) b.bakeds.push(s.baked);
    // RANKING AXIS (re-aim 2026-07-19): decode volume + queue starvation +
    // residency growth. bake.dPosted = bakes triggered this window (decode
    // volume); bake.dDecodeMs = main-thread decode ms; bake.maxQueueMs =
    // pre-admission starvation; wasmMB.main = residency level.
    if (s.bake) {
      if (s.bake.dPosted != null && s.bake.dPosted >= 0) b.dPosted.push(s.bake.dPosted);
      if (s.bake.dDecodeMs != null && s.bake.dDecodeMs >= 0) b.dDecodeMs.push(s.bake.dDecodeMs);
      if (s.bake.maxQueueMs != null && s.bake.maxQueueMs > b.maxQueueMs) b.maxQueueMs = s.bake.maxQueueMs;
    }
    if (s.wasmMB && s.wasmMB.main != null) b.wasmMB.push(s.wasmMB.main);
    if (s.pos && s.bake && s.bake.dPosted != null && s.bake.dPosted > b.worstDecode) {
      b.worstDecode = s.bake.dPosted; if (!b.waypoint || b.worstP95 < 0) b.waypoint = s.pos;
    }
    // Dwell: prefer measured frame-window time (frames×meanDt); fall back to the
    // emit cadence when frames aren't present.
    if (s.frames && s.dt && s.dt.p50) b.dwellSec += (s.frames * s.dt.p50) / 1000;
    else b.dwellSec += (opts.emitMs || 10000) / 1000;
  }
  var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
  var ranked = Object.keys(bins).map(function (lb) {
    var b = bins[lb];
    return {
      lb: b.lb,
      samples: b.n,
      dwellSec: round(b.dwellSec, 0),
      // decode/residency axis (the RANK keys):
      decodeVol: b.dPosted.length ? Math.round(sum(b.dPosted)) : null,   // total bakes attributed here
      decodeRate: round(median(b.dPosted), 1),                            // bakes/window (cold spike tell)
      decodeMs: b.dDecodeMs.length ? Math.round(sum(b.dDecodeMs)) : null, // main-thread decode ms
      maxQueueMs: b.maxQueueMs || null,                                   // pre-admission starvation
      wasmMB_max: b.wasmMB.length ? round(Math.max.apply(null, b.wasmMB), 1) : null,
      wasmMB_grow: b.wasmMB.length >= 2 ? round(b.wasmMB[b.wasmMB.length - 1] - b.wasmMB[0], 1) : null,
      // context only (NOT ranked):
      p95_med: round(median(b.p95s), 1),
      draw_med: round(median(b.draws), 0),
      baked_max: b.bakeds.length ? Math.max.apply(null, b.bakeds) : null,
      waypoint: b.waypoint,
    };
  }).filter(function (r) { return r.samples >= minSamples; });

  // Sort by decode work (total bakes), then starvation, then decode ms, then dwell.
  // If no bake data at all (legacy samples), fall back to p95 so old files still rank.
  var haveBake = ranked.some(function (r) { return r.decodeVol != null; });
  ranked.sort(function (a, b) {
    if (haveBake) {
      var av = a.decodeVol || 0, bv = b.decodeVol || 0;
      if (bv !== av) return bv - av;
      if ((b.maxQueueMs || 0) !== (a.maxQueueMs || 0)) return (b.maxQueueMs || 0) - (a.maxQueueMs || 0);
      if ((b.decodeMs || 0) !== (a.decodeMs || 0)) return (b.decodeMs || 0) - (a.decodeMs || 0);
      return b.dwellSec - a.dwellSec;
    }
    if (b.p95_med !== a.p95_med) return b.p95_med - a.p95_med;
    return b.dwellSec - a.dwellSec;
  });
  return ranked;
}

/** Render the ranked league as a committable markdown table. */
function renderLeagueMarkdown(ranked, meta) {
  meta = meta || {};
  var out = [];
  out.push("# perf league — worst content by DECODE/BAKE/RESIDENCY cost");
  out.push("");
  out.push("> GENERATED by perf_loop.cjs `rank` — do not hand-edit; re-run to refresh.");
  out.push("> Axis = CPU decode/bake/residency, NOT draw calls or fps (both ruled out —");
  out.push("> see docs/rynth-integration/perf-loop-reaim-2026-07-19.md). decodeVol = bakes");
  out.push("> attributed here; queueMs = pre-admission starvation; wasmΔ = residency growth.");
  if (meta.source) out.push("> source: `" + meta.source + "`  ·  samples: " + (meta.total || "?") + (meta.dropped ? "  ·  dropped: " + meta.dropped : ""));
  if (meta.stamp) out.push("> generated: " + meta.stamp);
  out.push("");
  out.push("| # | landblock | decodeVol | decode/win | decode ms | queueMs | wasm MB | wasmΔ | p95* | dwell s | n |");
  out.push("|--:|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  var dash = function (v) { return v == null ? "—" : v; };
  ranked.forEach(function (r, i) {
    out.push("| " + (i + 1) + " | `" + r.lb + "` | " + dash(r.decodeVol) + " | " + dash(r.decodeRate) + " | " +
      dash(r.decodeMs) + " | " + dash(r.maxQueueMs) + " | " + dash(r.wasmMB_max) + " | " + dash(r.wasmMB_grow) + " | " +
      dash(r.p95_med) + " | " + r.dwellSec + " | " + r.samples + " |");
  });
  out.push("");
  out.push("\\* p95 shown as context only — NOT the ranking axis (cold-load-inflated).");
  out.push("");
  return out.join("\n");
}

// ── tour slicing (TOUR step) ────────────────────────────────────────────────

/** From the ranked league, pick the landblocks a `perf-tour-vN` should visit:
 *  the top `top` offenders plus `control` healthy stretches (lowest p95, so a
 *  regression that only speeds up bad LBs by slowing good ones is visible).
 *  Returns {offenders:[lb...], control:[lb...]} — the driver turns these into a
 *  recorded route via goto-chain + RouteRecorder on a live pass. */
function sliceTourLbs(ranked, opts) {
  opts = opts || {};
  var top = opts.top || 3, control = opts.control || 1;
  var offenders = ranked.slice(0, top).map(function (r) { return r.lb; });
  // control = lowest decode cost (a healthy LB), so a fix that speeds offenders
  // by slowing quiet LBs is visible.
  var cost = function (r) { return r.decodeVol != null ? r.decodeVol : (r.p95_med || 0); };
  var healthy = ranked.slice().sort(function (a, b) { return cost(a) - cost(b); })
    .map(function (r) { return r.lb; })
    .filter(function (lb) { return offenders.indexOf(lb) < 0; })
    .slice(0, control);
  return { offenders: offenders, control: healthy };
}

/** Fork #1 — auto-build a replayable perf tour from ranked data, NO live
 *  recording pass. Each waypoint is the representative pose (worst frame) of a
 *  top offender + a healthy control, in offender-first order. `measure` drives
 *  bot.goto() through these waypoints and times the chain. Landblocks without a
 *  captured pose (sampler saw them before pos emission, or TryGetPlayerPose was
 *  null) are skipped with a note in `dropped`. */
function buildTour(ranked, opts) {
  opts = opts || {};
  var pick = sliceTourLbs(ranked, opts);
  var byLb = {};
  ranked.forEach(function (r) { byLb[r.lb] = r; });
  var order = pick.offenders.concat(pick.control);
  var waypoints = [], dropped = [];
  order.forEach(function (lb) {
    var r = byLb[lb];
    if (r && r.waypoint && r.waypoint.lb != null) waypoints.push({ lb: r.waypoint.lb, x: r.waypoint.x, y: r.waypoint.y, z: r.waypoint.z, forLb: lb, decodeVol: r.decodeVol, p95: r.p95_med });
    else dropped.push(lb);
  });
  return {
    name: opts.name || "perf-tour",
    schemaVersion: 2,
    source: "perf-tour-auto",
    kind: "waypoints",       // measure uses goto-chain mode, not followRoute
    offenders: pick.offenders,
    control: pick.control,
    waypoints: waypoints,
    dropped: dropped,
  };
}

// ── acceptance gate (MEASURE step) ──────────────────────────────────────────

/** Given per-run metrics for a baseline arm and a candidate arm, decide whether
 *  the candidate is a real, non-noise improvement. Each arm is an array of
 *  {routeMs, p95, draw, tri} (one entry per replay of the SAME tour).
 *
 *  A PASS requires BOTH:
 *    1. median improvement in the headline metric > minPct, AND
 *    2. distribution separation — the candidate's worst run beats the baseline's
 *       best run (non-overlap). Non-overlap is the cheap, honest guard against
 *       SwiftShader noise greenlighting a single lucky run.
 *  Headline metric defaults to routeMs (end-to-end, deterministic, hard to game);
 *  p95 is reported alongside so a shading-only regression can't hide. */
function gate(baseline, candidate, opts) {
  opts = opts || {};
  var metric = opts.metric || "routeMs";
  var minPct = opts.minPct != null ? opts.minPct : 3; // below this, treat as noise

  function vals(arm) { return sortedNums(arm.map(function (r) { return r[metric]; })); }
  var b = vals(baseline), c = vals(candidate);
  if (b.length < 2 || c.length < 2) {
    return { verdict: "INSUFFICIENT", reason: "need >=2 runs per arm (base=" + b.length + " cand=" + c.length + ")" };
  }
  var bMed = quantile(b, 50), cMed = quantile(c, 50);
  var improvePct = round(((bMed - cMed) / bMed) * 100, 1);
  var nonOverlap = Math.max.apply(null, c) < Math.min.apply(null, b); // cand worst < base best
  var meaningful = improvePct >= minPct;

  // secondary read: p95 must not regress even if the headline improves
  var p95b = median(baseline.map(function (r) { return r.p95; }));
  var p95c = median(candidate.map(function (r) { return r.p95; }));
  var p95Pct = p95b ? round(((p95b - p95c) / p95b) * 100, 1) : null;

  var verdict;
  if (meaningful && nonOverlap) verdict = "ACCEPT";
  else if (improvePct <= -minPct) verdict = "REGRESSION";
  else verdict = "INCONCLUSIVE";

  return {
    verdict: verdict,
    metric: metric,
    baselineMed: round(bMed, 1),
    candidateMed: round(cMed, 1),
    improvePct: improvePct,
    nonOverlap: nonOverlap,
    meaningful: meaningful,
    p95: { base: round(p95b, 1), cand: round(p95c, 1), improvePct: p95Pct },
    runs: { base: baseline.length, cand: candidate.length },
  };
}

module.exports = {
  parseSamples, rankByLandblock, renderLeagueMarkdown, sliceTourLbs, buildTour, gate,
  _internal: { quantile, median, sortedNums, round },
};
